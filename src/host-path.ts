import type { ContainerManagerApi } from "./types.js";
import { ContainerHelperError } from "./util.js";

/** A host path translated into something the container runtime can bind. */
export interface HostMount {
  /** Host source — use as the value in `ContainerConfig.volumes`. */
  source: string;
  /**
   * Path INSIDE the container that corresponds to the requested host path:
   * the container path you asked for, with `subPath` already joined. Use
   * this in commands and config, NOT the container path you passed in.
   */
  containerPath: string;
  /**
   * Offset within the mount, or "" when the source maps 1:1. Non-empty only
   * for named volumes — runtimes reject `-v volume/sub:/dest`, so the mount
   * root is the volume itself and the requested directory sits inside it.
   */
  subPath: string;
}

export interface ResolveMountOptions {
  /** Absolute mount point inside the container, e.g. "/data". */
  containerPath: string;
  /**
   * Absolute host-side path to expose. For your plugin's own private data
   * directory, pass your own `app.getDataDirPath()`.
   */
  hostPath: string;
}

/**
 * Translate an absolute host path into a mount that works regardless of how
 * Signal K itself is deployed (bare-metal, Docker with a bind, Docker with a
 * named volume).
 *
 * Use this to mount your plugin's own data directory:
 * `ContainerConfig.signalkDataMount` resolves to *signalk-container's* data
 * dir, not yours, and passing `app.getDataDirPath()` straight into `volumes`
 * works bare-metal but fails once Signal K runs in a container — the host
 * daemon cannot see a path that only exists inside the Signal K container.
 *
 * Errors are NOT pre-reported via `app.setPluginError` (this function has no
 * `app`), unlike ManagedContainer's lifecycle errors — let `startSafely`
 * surface them.
 *
 * @throws ContainerHelperError `invalid-option` when either path is relative,
 * `unsupported-manager` on signalk-container < 1.7.0, or `path-unreachable`
 * when Signal K is containerized and no mount covers `hostPath`.
 */
export async function resolveMount(
  manager: ContainerManagerApi,
  options: ResolveMountOptions,
): Promise<HostMount> {
  const { containerPath, hostPath } = options;

  if (!containerPath.startsWith("/")) {
    throw new ContainerHelperError(
      "invalid-option",
      `resolveMount: containerPath must be absolute, got '${containerPath}'`,
    );
  }
  if (!hostPath.startsWith("/")) {
    throw new ContainerHelperError(
      "invalid-option",
      `resolveMount: hostPath must be absolute, got '${hostPath}'`,
    );
  }

  if (typeof manager.resolveHostPath !== "function") {
    throw new ContainerHelperError(
      "unsupported-manager",
      "resolveMount requires signalk-container 1.7.0+ (resolveHostPath); " +
        "upgrade signalk-container to mount a path outside its own data dir",
    );
  }

  const resolved = await manager.resolveHostPath(hostPath);
  if (!resolved) {
    throw new ContainerHelperError(
      "path-unreachable",
      `resolveMount: Signal K runs in a container and no mount covers '${hostPath}', ` +
        "so the host runtime cannot reach it — bind that path into the Signal K " +
        "container, or choose one under the Signal K config root",
    );
  }

  const { source, subPath } = resolved;
  return {
    source,
    subPath,
    containerPath: subPath
      ? `${containerPath.replace(/\/$/, "")}/${subPath}`
      : containerPath,
  };
}
