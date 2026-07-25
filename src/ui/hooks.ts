// React hooks for the fetch-and-poll patterns every reference config panel
// re-implements: status polling, the /api/versions dropdown feed, and the
// check/apply update flow against ManagedContainer.registerUpdateRoutes.

import { useCallback, useEffect, useRef, useState } from "react";
import { deriveVersionsView, type VersionInfo } from "./versions.js";
import type { UpdateCheckResult } from "../types.js";

export interface StatusPollOptions<T> {
  /** Poll period. Default 5000. `0` disables re-polling (fetch once). */
  intervalMs?: number;
  /**
   * Value reported when the endpoint is unreachable or returns a
   * non-object body — e.g. `{ status: "not_running" }`. Captured on first
   * render; later changes are ignored (pass a literal, not state).
   */
  fallback?: T;
}

export interface StatusPoll<T> {
  /** Last parsed body; `fallback` (or null) when unreachable. */
  status: T | null;
  /** True until the first fetch settles. */
  loading: boolean;
  /** Fetch immediately (e.g. right after an action that changes state). */
  refresh: () => Promise<void>;
}

/**
 * Poll a plugin status endpoint (`/plugins/<id>/api/status`).
 *
 * Two lessons from the reference panels are baked in:
 * - The body is parsed even on non-2xx — unhealthy responses often carry
 *   fields the panel must still surface (and 503 bodies like
 *   `{ status: "not_running" }` are meaningful).
 * - Polls self-schedule instead of using setInterval, so a response slower
 *   than the period can't stack overlapping requests; a monotonic
 *   generation counter drops stale responses that land after newer ones.
 */
export function useStatusPoll<T = unknown>(
  url: string,
  options: StatusPollOptions<T> = {},
): StatusPoll<T> {
  const { intervalMs = 5000 } = options;
  const [status, setStatus] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const gen = useRef(0);
  const fallbackRef = useRef(options.fallback ?? null);

  const fetchOnce = useCallback(
    async (signal?: AbortSignal) => {
      const g = ++gen.current;
      let next: T | null = fallbackRef.current;
      try {
        const res = await fetch(url, { signal });
        const body: unknown = await res.json().catch(() => null);
        if (body && typeof body === "object") next = body as T;
      } catch {
        // offline / aborted — report the fallback
      }
      if (g !== gen.current) return;
      setStatus(next);
      setLoading(false);
    },
    [url],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const poll = async () => {
      await fetchOnce(controller.signal);
      if (!cancelled && intervalMs > 0) timer = setTimeout(poll, intervalMs);
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce, intervalMs]);

  return { status, loading, refresh: () => fetchOnce() };
}

export interface VersionsState {
  versions: VersionInfo[];
  /** Operator-facing error line ("" when the last fetch fully succeeded). */
  versionsError: string;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetch a plugin's `/api/versions` for the image-version dropdown. Fetches
 * once on mount; call `refresh` from a ↻ button. Accepts both the
 * structured `{ versions, sources }` response and a legacy bare array, and
 * preserves the previously shown list when the endpoint or network fails —
 * an empty dropdown would silently reset the operator's running image.
 */
export function useVersions(url: string): VersionsState {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [versionsError, setVersionsError] = useState("");
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);

  const refresh = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    try {
      const res = await fetch(url);
      const body: unknown = await res.json().catch(() => null);
      const view = deriveVersionsView(res.ok, body);
      if (g !== gen.current) return;
      if (view.versions !== null) setVersions(view.versions);
      setVersionsError(view.versionsError);
    } catch {
      // Offline: preserve whatever is already shown.
      if (g !== gen.current) return;
      setVersionsError("⚠ Offline — showing last known versions");
    }
    setLoading(false);
  }, [url]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { versions, versionsError, loading, refresh };
}

export interface ApplyResult {
  ok: boolean;
  /** The resolved tag from a successful apply. */
  tag?: string;
  error?: string;
}

export interface UpdateFlow {
  checking: boolean;
  applying: boolean;
  /** Last check result; cleared by a successful apply. */
  result: UpdateCheckResult | null;
  /** Last check/apply failure, "" when the last action succeeded. */
  error: string;
  check: () => Promise<void>;
  /** POST `{ tag }` to the apply route; omit `tag` to re-apply the current one. */
  apply: (tag?: string) => Promise<ApplyResult>;
}

/**
 * The check/apply update flow against the routes
 * `ManagedContainer.registerUpdateRoutes` mounts:
 *
 *   GET  checkUrl → UpdateCheckResult
 *   POST applyUrl → { success: true, tag } — body { tag?: string }
 *
 * Render `result` with {@link formatUpdateMessage}.
 */
export function useUpdateFlow(options: {
  checkUrl: string;
  applyUrl: string;
}): UpdateFlow {
  const { checkUrl, applyUrl } = options;
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      const res = await fetch(checkUrl);
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && body && typeof body === "object") {
        setResult(body as UpdateCheckResult);
      } else {
        const msg =
          (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        setError(`Check failed: ${msg}`);
      }
    } catch (err) {
      setError(
        `Check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setChecking(false);
  }, [checkUrl]);

  const apply = useCallback(
    async (tag?: string): Promise<ApplyResult> => {
      setApplying(true);
      setError("");
      let out: ApplyResult;
      try {
        const res = await fetch(applyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tag ? { tag } : {}),
        });
        const body = (await res.json().catch(() => null)) as {
          tag?: string;
          error?: string;
        } | null;
        if (res.ok) {
          out = { ok: true, tag: body?.tag };
          setResult(null);
        } else {
          out = { ok: false, error: body?.error ?? `HTTP ${res.status}` };
          setError(`Update failed: ${out.error}`);
        }
      } catch (err) {
        out = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        setError(`Update failed: ${out.error}`);
      }
      setApplying(false);
      return out;
    },
    [applyUrl],
  );

  return { checking, applying, result, error, check, apply };
}
