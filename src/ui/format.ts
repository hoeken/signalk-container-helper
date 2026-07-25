import type { UpdateCheckResult } from "../types.js";

/** Compact row/count formatting: 1234 → "1.2K", null → "—". */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** "just now" / "42s ago" / "5m ago" / "3h ago" / "2d ago". */
export function formatTimeAgo(isoTimestamp: string): string {
  try {
    const then = new Date(isoTimestamp).getTime();
    // Defensive: clamp to 0 in case server clock is ahead of client
    // (would otherwise produce confusing "-5s ago" strings).
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return isoTimestamp;
  }
}

/**
 * Format an {@link UpdateCheckResult} — what signalk-container's update
 * service returns and what `ManagedContainer.registerUpdateRoutes` serves
 * from GET `/api/update/check` — into a human-readable status line.
 */
export function formatUpdateMessage(
  result: Partial<UpdateCheckResult> | null | undefined,
): string {
  const {
    runningTag,
    tagKind,
    currentVersion,
    latestVersion,
    updateAvailable,
    reason,
    fromCache,
    lastSuccessfulCheckAt,
  } = result ?? {};

  if (reason === "offline") {
    if (fromCache && lastSuccessfulCheckAt) {
      const ago = formatTimeAgo(lastSuccessfulCheckAt);
      return `Offline — last checked ${ago}: ${updateAvailable ? "update available" : "up to date"}`;
    }
    return "Offline — never checked yet";
  }

  if (reason === "newer-version") {
    return `Update available: ${currentVersion} → ${latestVersion}`;
  }

  if (reason === "digest-drift") {
    const stableNote = latestVersion
      ? ` (latest stable: ${latestVersion})`
      : "";
    return `Image rebuild available for :${runningTag}${stableNote}`;
  }

  if (reason === "up-to-date") {
    if (tagKind === "floating" && latestVersion) {
      return `Up to date with :${runningTag} (latest stable: ${latestVersion})`;
    }
    return `Up to date (${currentVersion || runningTag})`;
  }

  if (reason === "older-than-pinned") {
    return `Pinned to ${currentVersion}; latest stable is ${latestVersion}`;
  }

  if (reason === "error") {
    return `Check error: ${result?.error || "unknown"}`;
  }

  return `State: ${reason || "unknown"}`;
}
