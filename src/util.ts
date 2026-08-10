import type { AppLike } from "./types.js";

/**
 * Allowed characters for an image tag before it is passed anywhere near the
 * container runtime. Same guard as the reference plugins (SAFE_TAG).
 */
export const IMAGE_TAG_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function isValidImageTag(tag: unknown): tag is string {
  return (
    typeof tag === "string" &&
    tag.length > 0 &&
    tag.length <= 128 &&
    IMAGE_TAG_PATTERN.test(tag)
  );
}

/** Normalize an unknown thrown value into a printable message. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ContainerHelperErrorCode =
  | "manager-unavailable"
  | "no-runtime"
  | "invalid-tag"
  | "address-unresolved"
  | "not-ready"
  | "recreate-limbo"
  | "cancelled";

/**
 * Typed error thrown by ManagedContainer/AdoptedContainer operations.
 * `reported` is true when the helper already surfaced the message via
 * `app.setPluginError` — `startSafely` uses it to avoid double-reporting.
 */
export class ContainerHelperError extends Error {
  readonly code: ContainerHelperErrorCode;
  reported: boolean;

  constructor(
    code: ContainerHelperErrorCode,
    message: string,
    reported = false,
  ) {
    super(message);
    this.name = "ContainerHelperError";
    this.code = code;
    this.reported = reported;
  }
}

/**
 * Signal K calls `plugin.start()` synchronously and ignores a returned
 * promise — an async `start` that rejects becomes an unhandled rejection with
 * no plugin error surfaced. Wrap the async body with this from a synchronous
 * `start()`:
 *
 *   start(config) {
 *     startSafely(app, () => asyncStart(config))
 *   }
 *
 * Errors already reported by the helpers (ContainerHelperError.reported) are
 * not re-reported; everything else lands in `setPluginError`.
 */
export function startSafely(app: AppLike, fn: () => Promise<unknown>): void {
  fn().catch((err: unknown) => {
    if (err instanceof ContainerHelperError && err.reported) {
      app.debug(`startup aborted: ${err.message}`);
      return;
    }
    app.setPluginError(`Startup failed: ${errMsg(err)}`);
  });
}

/**
 * Throws if `signal` has been aborted.
 *
 * Called after every await inside a long container operation. This is the
 * whole of the helper's cancellation: signalk-container exposes a signal only
 * on its one-off job API, so `ensureRunning`/`recreate`/`stop` cannot be
 * interrupted mid-call. Checking between steps is what stops an abandoned
 * operation from continuing — through the manager-global wait, the drift
 * probe and readiness polling — against a container the caller has already
 * torn down.
 *
 * `reported: true` because a cancellation is the caller's own doing: it asked
 * for the stop. Surfacing "Startup failed: cancelled" in the plugin error box
 * would be noise, so startSafely logs it at debug instead.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ContainerHelperError(
      "cancelled",
      "Operation cancelled by the caller.",
      true,
    );
  }
}
