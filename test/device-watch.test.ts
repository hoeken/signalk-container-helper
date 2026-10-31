import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideDeviceEvent,
  deviceProbeNeeded,
  DEVICE_STUCK_MS,
  DEVICE_WATCH_INTERVAL_MS,
  watchHostDevice,
  type DeviceObservation,
  type DeviceWatchEvent,
} from "../src/device-watch.js";
import type {
  ContainerManagerApi,
  HostDeviceProbeResult,
} from "../src/types.js";

const PATH = "/dev/serial/by-id/usb-Sonoff_Zigbee-if00-port0";
const PRESENT = { exists: true, nodes: ["x"], groups: ["dialout"] };
const ABSENT = { exists: false, nodes: [], groups: [] };

function obs(over: Partial<DeviceObservation>): DeviceObservation {
  return {
    present: true,
    started: true,
    healthy: false,
    now: 0,
    stuckMs: DEVICE_STUCK_MS,
    ...over,
  };
}

describe("decideDeviceEvent", () => {
  it("does nothing while the container is healthy", () => {
    const r = decideDeviceEvent(
      { absent: true },
      obs({ healthy: true, present: undefined }),
    );
    expect(r).toEqual({ event: undefined, next: { absent: false } });
  });

  it("reports an unplug once", () => {
    const first = decideDeviceEvent({ absent: false }, obs({ present: false }));
    expect(first.event).toBe("unplugged");
    const second = decideDeviceEvent(first.next, obs({ present: false }));
    expect(second.event).toBeUndefined();
  });

  it("reports the device coming back", () => {
    const r = decideDeviceEvent({ absent: true }, obs({ present: true }));
    expect(r).toEqual({ event: "pluggedIn", next: { absent: false } });
  });

  it("reports a first plug-in for a container never started", () => {
    const missing = decideDeviceEvent(
      { absent: false },
      obs({ started: false, present: false }),
    );
    expect(missing.event).toBeUndefined();
    const back = decideDeviceEvent(
      missing.next,
      obs({ started: false, present: true }),
    );
    expect(back.event).toBe("pluggedIn");
  });

  it("keeps its state when the probe cannot tell", () => {
    const state = { absent: true };
    expect(decideDeviceEvent(state, obs({ present: undefined }))).toEqual({
      event: undefined,
      next: state,
    });
  });

  it("reports stuck after stuckMs unhealthy with the device present", () => {
    const t0 = decideDeviceEvent({ absent: false }, obs({ now: 1000 }));
    expect(t0.event).toBeUndefined();
    const early = decideDeviceEvent(
      t0.next,
      obs({ now: 1000 + DEVICE_STUCK_MS - 1 }),
    );
    expect(early.event).toBeUndefined();
    const late = decideDeviceEvent(
      early.next,
      obs({ now: 1000 + DEVICE_STUCK_MS }),
    );
    expect(late).toEqual({ event: "stuck", next: { absent: false } });
  });

  it("never reports stuck while health is unknown", () => {
    const r = decideDeviceEvent(
      { absent: false, unhealthySince: 0 },
      obs({ healthy: undefined, now: 10 * DEVICE_STUCK_MS }),
    );
    expect(r.event).toBeUndefined();
  });
});

describe("deviceProbeNeeded", () => {
  it("skips the probe for a healthy started container", () => {
    expect(deviceProbeNeeded(true, true)).toBe(false);
    expect(deviceProbeNeeded(true, false)).toBe(true);
    expect(deviceProbeNeeded(true, undefined)).toBe(true);
    expect(deviceProbeNeeded(false, true)).toBe(true);
  });
});

describe("watchHostDevice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function manager(results: (HostDeviceProbeResult | null)[]) {
    const probe = vi.fn(() => Promise.resolve(results.shift() ?? null));
    return {
      probe,
      api: { probeHostDevice: probe } as unknown as ContainerManagerApi,
    };
  }

  it("reports unplug and return across ticks, then stops", async () => {
    const { api } = manager([ABSENT, ABSENT, PRESENT]);
    const events: DeviceWatchEvent[] = [];
    const watch = watchHostDevice({
      manager: api,
      path: PATH,
      isStarted: () => true,
      isHealthy: () => false,
      onEvent: (e) => {
        events.push(e);
      },
    });
    await vi.advanceTimersByTimeAsync(3 * DEVICE_WATCH_INTERVAL_MS);
    expect(events).toEqual(["unplugged", "pluggedIn"]);
    await watch.stop();
    await vi.advanceTimersByTimeAsync(3 * DEVICE_WATCH_INTERVAL_MS);
    expect(events).toEqual(["unplugged", "pluggedIn"]);
  });

  it("does not probe a healthy container", async () => {
    const { api, probe } = manager([]);
    const watch = watchHostDevice({
      manager: api,
      path: PATH,
      isStarted: () => true,
      isHealthy: () => true,
      onEvent: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(3 * DEVICE_WATCH_INTERVAL_MS);
    expect(probe).not.toHaveBeenCalled();
    await watch.stop();
  });

  it("starts from initiallyAbsent", async () => {
    const { api } = manager([PRESENT]);
    const events: DeviceWatchEvent[] = [];
    const watch = watchHostDevice({
      manager: api,
      path: PATH,
      isStarted: () => false,
      isHealthy: () => undefined,
      initiallyAbsent: true,
      onEvent: (e) => {
        events.push(e);
      },
    });
    await vi.advanceTimersByTimeAsync(DEVICE_WATCH_INTERVAL_MS);
    expect(events).toEqual(["pluggedIn"]);
    await watch.stop();
  });

  it("survives a failing handler and keeps watching", async () => {
    const { api } = manager([ABSENT, PRESENT]);
    const events: DeviceWatchEvent[] = [];
    const debug = vi.fn();
    const watch = watchHostDevice({
      manager: api,
      path: PATH,
      isStarted: () => true,
      isHealthy: () => false,
      debug,
      onEvent: (e) => {
        events.push(e);
        if (e === "unplugged") throw new Error("stop failed");
      },
    });
    await vi.advanceTimersByTimeAsync(2 * DEVICE_WATCH_INTERVAL_MS);
    expect(events).toEqual(["unplugged", "pluggedIn"]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("stop failed"));
    await watch.stop();
  });

  it("repeats stuck while the workload stays unhealthy", async () => {
    const probe = vi.fn(() => Promise.resolve(PRESENT));
    const events: DeviceWatchEvent[] = [];
    const watch = watchHostDevice({
      manager: { probeHostDevice: probe } as unknown as ContainerManagerApi,
      path: PATH,
      isStarted: () => true,
      isHealthy: () => false,
      onEvent: (e) => {
        events.push(e);
      },
    });
    await vi.advanceTimersByTimeAsync(
      DEVICE_STUCK_MS + DEVICE_WATCH_INTERVAL_MS,
    );
    expect(events).toEqual(["stuck"]);
    await vi.advanceTimersByTimeAsync(
      DEVICE_STUCK_MS + DEVICE_WATCH_INTERVAL_MS,
    );
    expect(events).toEqual(["stuck", "stuck"]);
    await watch.stop();
  });

  it("can be stopped from inside its handler", async () => {
    const { api, probe } = manager([ABSENT, PRESENT]);
    const events: DeviceWatchEvent[] = [];
    const watch = watchHostDevice({
      manager: api,
      path: PATH,
      isStarted: () => true,
      isHealthy: () => false,
      onEvent: async (e) => {
        events.push(e);
        await watch.stop();
      },
    });
    await vi.advanceTimersByTimeAsync(3 * DEVICE_WATCH_INTERVAL_MS);
    expect(events).toEqual(["unplugged"]);
    expect(probe).toHaveBeenCalledTimes(1);
    await watch.stop();
  });

  it("delivers nothing when stopped during a probe", async () => {
    let resolveProbe: (r: HostDeviceProbeResult) => void = () => undefined;
    const probe = vi.fn(
      () =>
        new Promise<HostDeviceProbeResult>((r) => {
          resolveProbe = r;
        }),
    );
    const events: DeviceWatchEvent[] = [];
    const watch = watchHostDevice({
      manager: { probeHostDevice: probe } as unknown as ContainerManagerApi,
      path: PATH,
      isStarted: () => true,
      isHealthy: () => false,
      onEvent: (e) => {
        events.push(e);
      },
    });
    await vi.advanceTimersByTimeAsync(DEVICE_WATCH_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    const stopping = watch.stop();
    resolveProbe(ABSENT);
    await stopping;
    expect(events).toEqual([]);
  });
});
