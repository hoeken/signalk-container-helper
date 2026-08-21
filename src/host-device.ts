/**
 * Asking whether the HOST has a device.
 *
 * A plugin cannot answer this itself. `stat("/dev/dri")` reports on the
 * plugin's own filesystem, which is the Signal K container whenever Signal K
 * is containerized — the common deployment — and that container has no
 * `/dev/dri` even on a machine with a GPU. The result is a silent false
 * negative: the plugin runs its workload under software rendering and nothing
 * says why.
 *
 * signalk-container can see the host, so it answers instead.
 */

import { ContainerHelperError } from "./util.js";
import type { ContainerManagerApi, HostDeviceProbeResult } from "./types.js";

/**
 * Probe a host path for device nodes and the groups that own them.
 *
 * ```ts
 * const gpu = await probeHostDevice(manager, "/dev/dri");
 * if (gpu?.exists) {
 *   config.devices = ["/dev/dri"];
 *   config.groupAdd = gpu.groups;   // names, resolved on the host
 * }
 * ```
 *
 * `groups` are NAMES rather than gids on purpose: `groupAdd` resolves names
 * against the host's `/etc/group`, and the gid of `render` or `video` differs
 * per distro and per install. Hardcoding a number — as the upstream
 * opencpn-kiosk compose does with `group_add: "993"` — silently loses access
 * on any host that numbers them differently.
 *
 * @returns the probe result, or **null meaning "unknown"** — no runtime, or
 * the host could not be inspected. That is deliberately distinct from
 * `{ exists: false }`, which means "definitely not there". Treat null as
 * "assume no device, but do not report it as absent".
 *
 * @throws ContainerHelperError `unsupported-manager` on signalk-container
 * older than 1.30.0, which has no probe at all. Catch it if the caller would
 * rather degrade than fail.
 */
export async function probeHostDevice(
  manager: ContainerManagerApi,
  path: string,
): Promise<HostDeviceProbeResult | null> {
  if (!path.startsWith("/")) {
    throw new ContainerHelperError(
      "invalid-option",
      `probeHostDevice: path must be absolute, got '${path}'`,
    );
  }
  if (typeof manager.probeHostDevice !== "function") {
    throw new ContainerHelperError(
      "unsupported-manager",
      "probeHostDevice requires signalk-container 1.30.0+; " +
        "upgrade it to detect host devices from a containerized Signal K",
    );
  }
  return manager.probeHostDevice(path);
}
