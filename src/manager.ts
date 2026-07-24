import type { ContainerManagerApi, ContainerRuntimeInfo } from "./types.js";
import { sleep } from "./util.js";

/**
 * Read the cross-plugin manager global. signalk-container publishes its API
 * on `globalThis` (each plugin only gets a shallow copy of `app`, so `app`
 * properties don't cross plugin boundaries). Returns undefined until
 * signalk-container's start() has run, or when it is disabled/uninstalled.
 */
export function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager;
}

export interface WaitForManagerOptions {
  /** Overall deadline for both phases. Default 60_000. */
  timeoutMs?: number;
  /** Poll interval while the global is absent. Default 500. */
  intervalMs?: number;
  /** Progress callback, e.g. to update the plugin status line per phase. */
  onWaiting?: (phase: "manager" | "runtime") => void;
}

export interface ManagerWaitResult {
  /**
   * The manager global, or undefined if signalk-container never appeared
   * within the deadline (not installed / not enabled).
   */
  manager: ContainerManagerApi | undefined;
  /**
   * Detected runtime, or null when detection failed or hasn't settled —
   * `manager && !runtime` means "signalk-container is present but found no
   * usable podman/docker", which deserves a different error message than a
   * missing manager.
   */
  runtime: ContainerRuntimeInfo | null;
}

/**
 * Two-phase wait for a usable container manager:
 *
 *  1. Poll `globalThis.__signalk_containerManager` — plugins start in
 *     alphabetical order, so consumers loading before signalk-container see
 *     undefined for a while.
 *  2. Wait for runtime detection to settle: `whenReady()` when available
 *     (signalk-container 1.6.0+), otherwise poll `getRuntime()`. whenReady
 *     resolves on success OR failure, so the runtime is re-checked after.
 *
 * Never throws; inspect the result to pick the right error message.
 */
export async function waitForContainerManager(
  options: WaitForManagerOptions = {},
): Promise<ManagerWaitResult> {
  const { timeoutMs = 60_000, intervalMs = 500, onWaiting } = options;
  const deadline = Date.now() + timeoutMs;

  let manager = getContainerManager();
  while (!manager && Date.now() < deadline) {
    onWaiting?.("manager");
    await sleep(intervalMs);
    manager = getContainerManager();
  }
  if (!manager) {
    return { manager: undefined, runtime: null };
  }

  if (!manager.getRuntime()) {
    onWaiting?.("runtime");
    if (typeof manager.whenReady === "function") {
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([manager.whenReady(), sleep(remaining)]);
    } else {
      // Pre-1.6.0 fallback: poll until detection settles or the deadline hits.
      while (!manager.getRuntime() && Date.now() < deadline) {
        await sleep(intervalMs);
      }
    }
  }

  return { manager, runtime: manager.getRuntime() };
}
