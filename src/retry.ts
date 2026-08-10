import { ContainerHelperError, throwIfAborted } from "./util.js";

export interface RetryForeverOptions {
  /** First delay after a failure. Default 15_000. */
  minDelayMs?: number;
  /** Ceiling the doubling backoff saturates at. Default 120_000. */
  maxDelayMs?: number;
  /**
   * Ends the loop. Rejects with `ContainerHelperError` code `"cancelled"`,
   * already flagged reported so `startSafely` logs it instead of surfacing a
   * plugin error for a stop the caller asked for.
   */
  signal?: AbortSignal;
  /**
   * Called after each failed attempt, before sleeping. This is where a
   * consumer keeps its status line truthful while the loop runs — typically
   * `setPluginError(\`… ${errMsg(err)} — retrying in ${nextDelayMs / 1000}s\`)`.
   *
   * Without it the caller has no way to distinguish "still retrying" from
   * "stuck", since the returned promise stays pending either way. Throwing
   * from this callback aborts the loop and propagates.
   */
  onAttemptFailed?: (
    err: unknown,
    nextDelayMs: number,
    attempt: number,
  ) => void;
}

/**
 * Sleep that does not hold the process open.
 *
 * Deliberately not the shared `sleep` from util.ts: a retry loop that never
 * gives up will almost always have a pending timer when Signal K shuts down,
 * and a ref'd timer would keep the process alive waiting for a retry of
 * something nobody is listening to any more.
 */
function unrefSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () =>
      new ContainerHelperError(
        "cancelled",
        "Operation cancelled by the caller.",
        true,
      );

    // Already aborted: `addEventListener` would never fire, so the sleep would
    // run to completion against a signal that is already dead. Reached when
    // something between the loop's abort check and here aborts — notably an
    // `onAttemptFailed` callback that gives up.
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Node-only; a browser/edge runtime returns a plain number.
    (timer as unknown as { unref?: () => void }).unref?.();

    // Without this the backoff runs to completion before the loop notices the
    // abort — a `stop()` during a retry would stall for up to the full ceiling
    // delay, which is exactly the wait cancellation exists to cut short.
    function onAbort() {
      clearTimeout(timer);
      reject(cancelled());
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One signal that aborts when any input does.
 *
 * Hand-rolled rather than `AbortSignal.any()`: v0.3.0 lowered the Node floor
 * to 22 on the basis that this library touches no newer API, and reaching for
 * one here would quietly walk that back.
 *
 * Returns the sole signal when only one is given (nothing to compose), and
 * `undefined` when none is — so the common single-signal path allocates
 * nothing.
 */
export function anySignal(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  // Deduplicate: the same signal passed twice would overwrite its own entry in
  // `handlers` below, leaking the listener the second registration replaced.
  const present = [
    ...new Set(signals.filter((s): s is AbortSignal => s !== undefined)),
  ];
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  const controller = new AbortController();
  // Check every signal before registering any listener, so an already-aborted
  // one short-circuits without leaving listeners attached to its siblings.
  const already = present.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return controller.signal;
  }

  const handlers = new Map<AbortSignal, () => void>();
  const abort = (reason: unknown) => {
    for (const [s, handler] of handlers)
      s.removeEventListener("abort", handler);
    controller.abort(reason);
  };
  for (const s of present) {
    const handler = () => abort(s.reason);
    handlers.set(s, handler);
    s.addEventListener("abort", handler, { once: true });
  }
  return controller.signal;
}

/**
 * Reject a delay bound that could not produce a sane backoff.
 *
 * `setTimeout(NaN)` fires on the next tick, so an unvalidated NaN turns the
 * loop into a hot spin against the container runtime rather than a backoff.
 */
function requireDelay(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ContainerHelperError(
      "invalid-option",
      `${name} must be a non-negative finite number, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Run `fn` until it succeeds, backing off from `minDelayMs`, doubling to a
 * `maxDelayMs` ceiling, retrying indefinitely.
 *
 * A container that lost a boot race should not stay broken until a human
 * restarts the plugin. On a boat that human can be weeks away, so "give up and
 * report" is the wrong terminal state for a transient failure — the plugin
 * should still be trying when someone finally looks at it. That is why this
 * has no attempt cap: the only exits are success and cancellation.
 *
 * The caller supplies the unit of work, so this composes with anything —
 * `ManagedContainer.start()` for the container case, or a bare HTTP probe for
 * a plugin pointed at a service it does not manage.
 */
export async function retryForever<T>(
  fn: () => Promise<T>,
  options: RetryForeverOptions = {},
): Promise<T> {
  const {
    minDelayMs = 15_000,
    maxDelayMs = 120_000,
    signal,
    onAttemptFailed,
  } = options;
  // Validate before the first attempt: a bad bound must fail loudly here
  // rather than silently becoming a hot spin somewhere inside the loop.
  requireDelay("minDelayMs", minDelayMs);
  requireDelay("maxDelayMs", maxDelayMs);
  // A caller that passes min > max means the ceiling; clamping beats doubling
  // past it forever.
  const ceiling = Math.max(minDelayMs, maxDelayMs);

  let delay = minDelayMs;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (err) {
      // A cancelled attempt is the caller's own doing — surface it rather than
      // treating it as a failure worth retrying, or the loop would outlive the
      // stop that cancelled it.
      if (err instanceof ContainerHelperError && err.code === "cancelled") {
        throw err;
      }
      throwIfAborted(signal);
      onAttemptFailed?.(err, delay, attempt);
      await unrefSleep(delay, signal);
      delay = Math.min(delay * 2, ceiling);
    }
  }
}
