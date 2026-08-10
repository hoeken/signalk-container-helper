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

/**
 * How far to follow `.cause` / `AggregateError.errors` before giving up.
 * Deep enough for the real chains (undici wraps twice), shallow enough that a
 * pathological or cyclic graph cannot produce an unbounded status line.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * Normalize an unknown thrown value into a printable message, following the
 * `.cause` chain and flattening `AggregateError`.
 *
 * The naive `err.message` loses exactly the part an operator needs. undici's
 * fetch rejects with a bare `TypeError: fetch failed` and hides the actionable
 * syscall in `err.cause`, so every consumer polling a containerized app gets
 * "fetch failed" instead of "connect ECONNREFUSED 127.0.0.1:3010". Node >= 20's
 * Happy Eyeballs is worse: it rejects with an `AggregateError` carrying no
 * message of its own, which renders as the literal string "AggregateError".
 *
 * Consumers cannot fix this downstream — this library renders errors to strings
 * internally (readiness timeouts, `fail()`) before a consumer ever sees them.
 */
export function errMsg(err: unknown): string {
  return describeError(err, 0);
}

function describeError(err: unknown, depth: number): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    // The depth cap applies here too: `errors` arrays can nest, or be cyclic
    // when something overrides the own property after construction.
    if (depth >= MAX_CAUSE_DEPTH) {
      return err.message || "AggregateError";
    }
    const inner = err.errors
      .map((e: unknown) => describeError(e, depth + 1))
      .join("; ");
    // A Happy-Eyeballs AggregateError usually carries no message of its own.
    const rendered =
      err.message && err.message !== "AggregateError"
        ? `${err.message}: ${inner}`
        : inner;
    // An AggregateError can carry BOTH errors and its own cause. Dropping the
    // cause here would swallow exactly the detail this function exists to
    // surface, so append it rather than returning early.
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
      return `${rendered}: ${describeError(cause, depth + 1)}`;
    }
    return rendered;
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
      return `${err.message}: ${describeError(cause, depth + 1)}`;
    }
    return err.message;
  }
  return String(err);
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
