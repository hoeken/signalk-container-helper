// Resolving the host:port a container is reachable on.
//
// Extracted from ManagedContainer so a plugin that drives `ensureRunning`
// itself — rather than handing its lifecycle to ManagedContainer — can still
// share this. Two of the three reference plugins are in that position, and
// both had hand-rolled a copy; one of those copies hardcoded the `sk-` prefix
// and so broke under a non-default SIGNALK_CONTAINER_NAMESPACE, which is
// exactly the bug `unprefixedName` matching below avoids.

import type { ContainerInfo, ContainerManagerApi } from "./types.js";
import { errMsg } from "./util.js";

/**
 * Find the live container for an unprefixed managed name.
 *
 * Two passes so the reliable key wins regardless of list order: an exact
 * `unprefixedName` match anywhere beats a legacy prefix match.
 */
export function matchContainerInfo(
  list: ContainerInfo[],
  name: string,
): ContainerInfo | undefined {
  return (
    list.find((c) => c.unprefixedName === name) ??
    list.find(
      (c) => c.unprefixedName === undefined && matchesLegacyName(c.name, name),
    )
  );
}

/**
 * Pre-`unprefixedName` managers reported only the prefixed name, so fall back
 * to matching `<namespace>-<name>` for any lowercase-alphanumeric namespace —
 * NOT a hardcoded `sk-`, which is what breaks under
 * SIGNALK_CONTAINER_NAMESPACE.
 */
export function matchesLegacyName(liveName: string, name: string): boolean {
  if (liveName === name) return true;
  const suffix = `-${name}`;
  if (!liveName.endsWith(suffix)) return false;
  const prefix = liveName.slice(0, -suffix.length);
  return /^[a-z0-9]+$/.test(prefix);
}

/**
 * `host:port` to reach `containerPort` of the named container from the Signal
 * K process, or null when it cannot be determined. Never throws.
 *
 * Asks `resolveContainerAddress` first, then falls back to parsing the port
 * bindings out of `listContainers()`: the resolver's process-local cache can
 * return a stale port after a recreate (seen in production by signalk-backup).
 *
 * `resolveContainerAddress` has three outcomes, and the throw is the one that
 * surprises people — it throws when the port WAS declared in
 * `signalkAccessiblePorts` but `ensureRunning()` has not run yet. Caught here
 * so a caller ordering its startup differently degrades to the fallback
 * instead of failing.
 */
export async function resolveContainerAddress(
  manager: ContainerManagerApi | undefined,
  containerName: string,
  containerPort: number,
  debug?: (msg: string) => void,
): Promise<string | null> {
  if (!manager) return null;

  try {
    const answer = await manager.resolveContainerAddress(
      containerName,
      containerPort,
    );
    if (answer) return answer;
  } catch (err) {
    debug?.(`resolveContainerAddress failed: ${errMsg(err)}`);
  }

  try {
    const found = matchContainerInfo(
      await manager.listContainers(),
      containerName,
    );
    const wanted = `->${containerPort}/tcp`;
    for (const entry of found?.ports ?? []) {
      if (!entry.endsWith(wanted)) continue;
      const hostPart = entry.slice(0, -wanted.length);
      if (hostPart.includes(":")) return hostPart;
    }
  } catch (err) {
    debug?.(`listContainers port fallback failed: ${errMsg(err)}`);
  }

  return null;
}
