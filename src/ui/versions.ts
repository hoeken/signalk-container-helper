// Pure view-logic for the image-version dropdown, extracted from the
// reference config panels (originally unit-tested in
// mayara-server-signalk-plugin) so it can be tested without a DOM. These
// functions decide what the panel shows from an /api/versions response;
// the VersionSelect component only wires them to state and JSX.

/** One selectable image version, as served by a plugin's /api/versions. */
export interface VersionInfo {
  tag: string;
  prerelease?: boolean;
  /** Set for per-PR test images (tag `pr<N>`). */
  pr?: number;
  /** PR title, shown next to PR test images. */
  title?: string;
}

/** Per-source outcome flags in the structured /api/versions response. */
export type VersionSourceState = "ok" | "rate-limited" | "error";

/**
 * The structured /api/versions response shape. A legacy bare
 * `VersionInfo[]` body is also accepted by {@link deriveVersionsView}.
 */
export interface VersionsResponse {
  versions: VersionInfo[];
  sources?: Partial<Record<"releases" | "prImages", VersionSourceState>>;
}

export interface VersionsView {
  /** `null` means "keep the prior dropdown rather than wipe it". */
  versions: VersionInfo[] | null;
  /** Operator-facing error line; empty when all sources succeeded. */
  versionsError: string;
}

/**
 * Derive the versions list and the operator-facing error line from an
 * /api/versions response.
 *
 * @param ok - `res.ok`
 * @param body - parsed JSON body: the structured {@link VersionsResponse}
 *   shape, or a legacy bare array
 */
export function deriveVersionsView(ok: boolean, body: unknown): VersionsView {
  if (!ok) {
    // All sources failed (e.g. 502): the caller keeps its prior list; tell
    // the operator why rather than implying the dropdown is authoritative.
    return {
      versions: null,
      versionsError:
        "⚠ Could not reach GitHub — showing last known versions, retry",
    };
  }
  // Guard against a malformed 200 payload (null / non-object / no fields)
  // so reading .versions/.sources can't throw before the fallbacks apply.
  const obj = body && typeof body === "object" ? body : {};
  const list = Array.isArray(obj)
    ? (obj as VersionInfo[])
    : Array.isArray((obj as VersionsResponse).versions)
      ? (obj as VersionsResponse).versions
      : [];
  const sources =
    !Array.isArray(obj) &&
    (obj as VersionsResponse).sources &&
    typeof (obj as VersionsResponse).sources === "object"
      ? ((obj as VersionsResponse).sources as NonNullable<
          VersionsResponse["sources"]
        >)
      : {};
  let versionsError = "";
  if (sources.prImages === "rate-limited") {
    // The PR-images source specifically failed — name it, since a running
    // pr<N> vanishing from the list is the visible symptom operators hit.
    versionsError =
      "⚠ GitHub rate-limited — PR test images temporarily unavailable, retry shortly";
  } else if (sources.releases === "rate-limited") {
    versionsError =
      "⚠ GitHub rate-limited — some versions temporarily unavailable, retry shortly";
  } else if (sources.prImages === "error" || sources.releases === "error") {
    versionsError = "⚠ Could not fetch some versions from GitHub, retry";
  }
  return { versions: list, versionsError };
}

export interface SplitVersionsOptions {
  /** Stable releases to show. Default 5. */
  stableCount?: number;
  /** Pre-releases to show. Default 3. */
  preCount?: number;
}

/**
 * Split the version list into the buckets the dropdown renders: PR test
 * images, the top N stable releases, and the top N pre-releases. The single
 * source of the slice limits — the VersionSelect option builder AND
 * {@link shownTags} both consume this, so the running-tag fallback can never
 * disagree with what is actually shown.
 */
export function splitVersions(
  versions: VersionInfo[],
  options: SplitVersionsOptions = {},
): {
  prVersions: VersionInfo[];
  stableVersions: VersionInfo[];
  preVersions: VersionInfo[];
} {
  const { stableCount = 5, preCount = 3 } = options;
  const prVersions = versions.filter((v) => typeof v.pr === "number");
  const releaseVersions = versions.filter((v) => typeof v.pr !== "number");
  const stableVersions = releaseVersions
    .filter((v) => !v.prerelease)
    .slice(0, stableCount);
  const preVersions = releaseVersions
    .filter((v) => v.prerelease)
    .slice(0, preCount);
  return { prVersions, stableVersions, preVersions };
}

/**
 * The set of tags the dropdown renders as real options: the floating tags
 * (e.g. `latest`, `main`) plus every bucketed version. Used to decide
 * whether the running tag needs a synthetic fallback option.
 */
export function shownTags(
  versions: VersionInfo[],
  floatingTags: string[] = ["latest"],
  options: SplitVersionsOptions = {},
): Set<string> {
  const { prVersions, stableVersions, preVersions } = splitVersions(
    versions,
    options,
  );
  return new Set([
    ...floatingTags,
    ...preVersions.map((v) => v.tag),
    ...stableVersions.map((v) => v.tag),
    ...prVersions.map((v) => v.tag),
  ]);
}

/**
 * The running image's tag if it is NOT among the rendered options (so a
 * controlled `<select>` would otherwise render blank and silently reset the
 * operator's real running image), else `null`. Covers a pr<N> whose /pulls
 * fetch was rate-limited and a stable pin that fell out of the top-N.
 */
export function runningTagFallback(
  value: string | null | undefined,
  versions: VersionInfo[],
  floatingTags: string[] = ["latest"],
  options: SplitVersionsOptions = {},
): string | null {
  if (!value) return null;
  return shownTags(versions, floatingTags, options).has(value) ? null : value;
}
