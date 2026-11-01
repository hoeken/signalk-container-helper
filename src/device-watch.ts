/**
 * Following a host device that can be unplugged while its container runs.
 *
 * A container gets its device nodes when it is created. When the device is
 * pulled, the program inside usually exits, and `unless-stopped` restarts it
 * against a node that is gone, over and over. When the device comes back it
 * may get another node (ttyUSB1 for ttyUSB0), which the old container never
 * sees. Nothing in the runtime notices either event, so the plugin has to.
 *
 * `watchHostDevice` polls the host through {@link probeHostDevice} and tells
 * the plugin when to stop its container, when to (re)create it, and when a
 * container that has its device has stayed unhealthy too long. What "stop" and
 * "recreate" mean stays with the plugin.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { probeHostDevice } from "./host-device.js";
import { errMsg } from "./util.js";
import type { ContainerManagerApi } from "./types.js";

/** Default poll interval. signalk-container caches a probe for 60 s. */
export const DEVICE_WATCH_INTERVAL_MS = 30_000;
/** Default time a container may stay unhealthy with its device present. */
export const DEVICE_STUCK_MS = 180_000;

/**
 * Marks the async call chain of each `onEvent` call, so `stop()` can tell the
 * running handler, which must not wait for itself, from any other caller that
 * happens to run meanwhile. The mark is per call: work an earlier handler left
 * running (a timer, a retry loop) carries a stale mark and still waits.
 *
 * Node 22 tracks a context through every promise in the process while any
 * storage is enabled, which costs Signal K's whole event loop, so the storage
 * is disabled whenever no handler of any watch runs.
 */
const handlerOf = new AsyncLocalStorage<object>();
let handlersRunning = 0;

export interface DeviceWatchState {
  /** The device was missing on the last tick that could tell. */
  absent: boolean;
  /** When the container was first seen unhealthy with its device present. */
  unhealthySince?: number;
}

export interface DeviceObservation {
  /** The host probe: undefined when it could not tell. */
  present: boolean | undefined;
  /** The plugin has created the container. */
  started: boolean;
  /** The workload's health; undefined when the plugin cannot tell. */
  healthy: boolean | undefined;
  now: number;
  stuckMs: number;
}

/**
 * - `unplugged`: the device went away under a started container.
 * - `pluggedIn`: the device is back (or appeared for the first time).
 * - `stuck`: the device is there, the container is not healthy.
 */
export type DeviceWatchEvent = "unplugged" | "pluggedIn" | "stuck";

/** Whether a tick needs to ask the host at all. */
export function deviceProbeNeeded(
  started: boolean,
  healthy: boolean | undefined,
): boolean {
  return !started || healthy !== true;
}

/** The decision of one tick, and the state for the next one. */
export function decideDeviceEvent(
  state: DeviceWatchState,
  obs: DeviceObservation,
): { event: DeviceWatchEvent | undefined; next: DeviceWatchState } {
  if (obs.started && obs.healthy === true) {
    return { event: undefined, next: { absent: false } };
  }
  if (obs.present === undefined) return { event: undefined, next: state };
  if (!obs.present) {
    return {
      event: obs.started && !state.absent ? "unplugged" : undefined,
      next: { absent: true },
    };
  }
  if (state.absent || !obs.started) {
    return {
      event: state.absent ? "pluggedIn" : undefined,
      next: { absent: false },
    };
  }
  if (obs.healthy === undefined) return { event: undefined, next: state };
  const unhealthySince = state.unhealthySince ?? obs.now;
  if (obs.now - unhealthySince >= obs.stuckMs) {
    return { event: "stuck", next: { absent: false } };
  }
  return { event: undefined, next: { absent: false, unhealthySince } };
}

export interface WatchHostDeviceOptions {
  manager: ContainerManagerApi;
  /** Host path of the device, ideally a `/dev/serial/by-id/…` link. */
  path: string;
  /** Whether the plugin has created the container for this device. */
  isStarted: () => boolean;
  /**
   * Whether the workload works. Return undefined when the plugin cannot tell
   * (its own connection to the workload is down): no `stuck` is raised then.
   */
  isHealthy: () => boolean | undefined;
  /**
   * Called for each event, never while the previous call runs and never after
   * `stop()`. `unplugged` and `pluggedIn` fire once per transition; `stuck`
   * repeats every `stuckMs` while the workload stays unhealthy. A rejection is
   * logged through `debug` and the watch moves on: a recreate that failed shows
   * up again as `stuck`.
   */
  onEvent: (event: DeviceWatchEvent) => Promise<void> | void;
  /** The device was missing when the plugin last looked. Default false. */
  initiallyAbsent?: boolean;
  intervalMs?: number;
  stuckMs?: number;
  debug?: (msg: string) => void;
}

export interface HostDeviceWatch {
  /**
   * Stops polling and waits for a tick in progress. Called from inside
   * `onEvent` it returns at once instead of waiting for itself; that includes
   * anything the running handler started that calls it while the handler is
   * still running, such as a listener it triggers synchronously.
   */
  stop(): Promise<void>;
}

/**
 * Poll the host for `path` and report its transitions.
 *
 * ```ts
 * const watch = watchHostDevice({
 *   manager,
 *   path: "/dev/serial/by-id/usb-…",
 *   isStarted: () => started,
 *   isHealthy: () => bridge.online,
 *   onEvent: async (event) => {
 *     if (event === "unplugged") await manager.stop(name);
 *     else await container.applyUpdate(tag); // recreate with the new node
 *   },
 * });
 * // plugin.stop():
 * await watch.stop();
 * ```
 *
 * A healthy started container is never probed, so the cost of a probe (a
 * short-lived container under a containerized Signal K) is paid only while
 * something is wrong. A probe that cannot tell (`null`, or an older
 * signalk-container) changes nothing. The first tick runs one interval after
 * the call. `stuck` repeats every `stuckMs` (plus up to one interval) for as
 * long as the workload stays unhealthy with its device present.
 */
export function watchHostDevice(
  options: WatchHostDeviceOptions,
): HostDeviceWatch {
  const debug = options.debug ?? (() => undefined);
  const stuckMs = options.stuckMs ?? DEVICE_STUCK_MS;
  let state: DeviceWatchState = { absent: options.initiallyAbsent ?? false };
  let stopped = false;
  let tick: Promise<void> | undefined;
  let handlerCall: object | undefined;

  const once = async (): Promise<void> => {
    const started = options.isStarted();
    const healthy = options.isHealthy();
    let present: boolean | undefined;
    if (deviceProbeNeeded(started, healthy)) {
      try {
        present = (await probeHostDevice(options.manager, options.path))
          ?.exists;
      } catch (err) {
        debug(`watchHostDevice: probing ${options.path}: ${errMsg(err)}`);
      }
      if (stopped) return;
    }
    const { event, next } = decideDeviceEvent(state, {
      present,
      started,
      healthy,
      now: Date.now(),
      stuckMs,
    });
    state = next;
    if (event === undefined) return;
    debug(`watchHostDevice: ${options.path} ${event}`);
    const call = {};
    handlerCall = call;
    handlersRunning++;
    try {
      await handlerOf.run(call, () => options.onEvent(event));
    } finally {
      handlerCall = undefined;
      if (--handlersRunning === 0) handlerOf.disable();
    }
  };

  const timer = setInterval(() => {
    if (stopped || tick !== undefined) return;
    tick = once()
      .catch((err: unknown) => {
        debug(`watchHostDevice: ${options.path}: ${errMsg(err)}`);
      })
      .finally(() => {
        tick = undefined;
      });
  }, options.intervalMs ?? DEVICE_WATCH_INTERVAL_MS);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Awaiting the tick from inside its own handler would never resolve.
      if (handlerCall === undefined || handlerOf.getStore() !== handlerCall) {
        await tick;
      }
    },
  };
}
