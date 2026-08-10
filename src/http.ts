import { errMsg, sleep } from "./util.js";

/** Injectable fetch for tests; matches the global fetch signature loosely. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; [key: string]: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FetchWithTimeoutOptions {
  /** Per-request timeout via AbortController. Default 10_000. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  [key: string]: unknown;
}

/**
 * `fetch` with an AbortController timeout — the bare pattern every reference
 * plugin re-implements for talking to the app inside its container.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const { timeoutMs = 10_000, fetchImpl, ...init } = options;
  const impl = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await impl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitForHttpReadyOptions {
  /** Overall deadline. Default 60_000. */
  maxMs?: number;
  /** Delay between attempts. Default 1_000. */
  intervalMs?: number;
  /** Per-request timeout. Default 2_000. */
  requestTimeoutMs?: number;
  fetchImpl?: FetchLike;
  /**
   * Stops polling when aborted, throwing an `AbortError` (a `DOMException`,
   * matching what `fetch` itself throws) rather than the deadline error — a
   * caller that cancelled must be able to tell "I stopped this" from "the app
   * never came up". Without it, a caller that has given up still waits out
   * the full `maxMs`: up to a minute of pointless requests against a
   * container it is about to stop.
   */
  signal?: AbortSignal;
}

/**
 * Poll a URL until it answers 2xx, or throw when the deadline passes.
 * "Container running" is not "app ready" — every managed plugin polls the
 * containerized app's own health endpoint after ensureRunning.
 */
export async function waitForHttpReady(
  url: string,
  options: WaitForHttpReadyOptions = {},
): Promise<void> {
  const {
    maxMs = 60_000,
    intervalMs = 1_000,
    requestTimeoutMs = 2_000,
    fetchImpl,
    signal,
  } = options;
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  // Aborting must NOT fall through to the deadline message below: a caller
  // that cancelled needs to tell "I stopped this" from "the app never came
  // up", and reporting the latter would put a readiness failure on screen for
  // a container it deliberately tore down.
  const aborted = () =>
    new DOMException(
      `Readiness polling aborted for ${url}${
        lastErr === undefined ? "" : ` (last error: ${errMsg(lastErr)})`
      }`,
      "AbortError",
    );
  for (;;) {
    if (signal?.aborted) throw aborted();
    try {
      const res = await fetchWithTimeout(url, {
        timeoutMs: requestTimeoutMs,
        fetchImpl,
      });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (signal?.aborted) throw aborted();
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(
    `${url} did not become ready within ${maxMs}ms: ${errMsg(lastErr)}`,
  );
}

export interface ProbeHttpHealthOptions {
  /** Total attempts. Default 3. */
  attempts?: number;
  /** Per-attempt timeout. Default 5_000. */
  attemptTimeoutMs?: number;
  /** Delay between attempts. Default 2_000. */
  retryDelayMs?: number;
  /**
   * Threshold above which a successful probe is flagged slow (likely disk
   * I/O contention on SD-card hosts). Default 1_500.
   */
  slowMs?: number;
  fetchImpl?: FetchLike;
}

export interface HealthProbeResult {
  reachable: boolean;
  /** Set when reachable but the successful attempt exceeded `slowMs`. */
  slowMs?: number;
}

/**
 * Retrying liveness probe with slow-response detection. Signal K's plugin
 * API has no warning tier, so callers typically report a slow-but-healthy
 * result through `setPluginStatus` rather than `setPluginError`.
 * Never throws.
 */
export async function probeHttpHealth(
  url: string,
  options: ProbeHttpHealthOptions = {},
): Promise<HealthProbeResult> {
  const {
    attempts = 3,
    attemptTimeoutMs = 5_000,
    retryDelayMs = 2_000,
    slowMs = 1_500,
    fetchImpl,
  } = options;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(url, {
        timeoutMs: attemptTimeoutMs,
        fetchImpl,
      });
      if (!res.ok) continue;
      const elapsed = Date.now() - started;
      return elapsed > slowMs
        ? { reachable: true, slowMs: elapsed }
        : { reachable: true };
    } catch {
      // try again
    }
  }
  return { reachable: false };
}
