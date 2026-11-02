import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { ContainerManagerApi } from "./types.js";
import { classifyTag } from "./util.js";
import {
  buildVersionSource,
  type VersionSourceSpec,
} from "./version-source.js";

/** How long to wait for signalk-internet's first state after a start. */
const DEFAULT_LINK_WAIT_MS = 60_000;
/**
 * How often to ask again while the link is restricted, as often as
 * signalk-container retries the update checks it held back.
 */
const DEFAULT_LINK_RETRY_MS = 15 * 60_000;
/** How long to wait for the container to report a version after update(). */
const DEFAULT_VERSION_WAIT_MS = 120_000;
const VERSION_POLL_MS = 2_000;
/**
 * How long a later ask for the link waits. Positive, so it also bounds the
 * server's plugin-list read and the signal can end it.
 */
const RETRY_LINK_WAIT_MS = 5_000;
/** The longest delay setTimeout keeps; a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface ImageAfterPluginUpdateOptions {
  manager: ContainerManagerApi;
  /** Your plugin's version, from its package.json. */
  pluginVersion: string;
  /**
   * The file that records the plugin version the check last finished under,
   * such as `${app.getDataDirPath()}/image-check.json`. One file per
   * container: a second container sharing it would find the version
   * recorded and never be checked.
   */
  stateFile: string;
  /**
   * The image tag the container is configured with. Only a floating tag,
   * such as `latest`, is updated: signalk-container moves a container to a
   * newer image of its tag only where the config sets
   * `autoUpdateOnFloatingTag`. Its update checks may pull the tag to compare
   * digests, but the container stays on the image it runs. Any other tag
   * names what the operator chose and stays.
   */
  tag: string;
  /**
   * Where the latest release comes from, as for update detection. A fetch
   * that fails is tried again every `linkRetryMs`.
   */
  versionSource: VersionSourceSpec;
  /**
   * The version the container runs, such as `9.4.3`, without a product
   * name around it; null when unknown. Anything but a semver-style version
   * (a dotted number, with an optional `v` before it and a `-` pre-release
   * or `+` build after it) counts as unknown: `9.4.3 (build 5)` does. An
   * unknown version is asked for again every `linkRetryMs`.
   */
  currentVersion: () => Promise<string | null>;
  /**
   * Pull the tag again, then recreate the container on it, under your
   * plugin's lifecycle lock: the pull first, because `recreate()` alone does
   * not pull an image already on the host. `ManagedContainer.applyUpdate()`
   * with `pull: true` does both. Resolve true once the container was
   * recreated, even where a later step failed: a recreate that is not
   * recorded happens again at every start. Resolve false, or throw, where it
   * was not; neither records anything, so the next start checks again.
   * `signal` is the check's own.
   */
  update: (signal: AbortSignal) => Promise<boolean>;
  /**
   * How long to wait for the first state of an enabled signalk-internet
   * that has published none yet, as right after a restart. Default 60 s;
   * at least 1 ms.
   */
  linkWaitMs?: number;
  /**
   * How often to ask again while the link is restricted or a version cannot
   * be read. Default 15 min.
   */
  linkRetryMs?: number;
  /**
   * How long to wait, after `update()`, for `currentVersion` to report the
   * latest release or a later one, as while the recreated container starts.
   * Default 2 min.
   */
  versionWaitMs?: number;
  /**
   * Ends the check; abort it when your plugin stops. Required: the check can
   * wait as long as the link stays restricted, and a check that outlives its
   * plugin would recreate a container nobody runs any more.
   */
  signal: AbortSignal;
}

/**
 * How the check ended. `up-to-date`, `updated` and `behind-after-update`
 * record the plugin version, and so does an `aborted` after `update()`
 * applied an update; the next start then returns `plugin-unchanged` until
 * the plugin is updated again. After `tag-not-floating`, `link-restricted`,
 * `not-applied` or another `aborted`, the next start checks again.
 */
export type ImageAfterPluginUpdateOutcome =
  /** The plugin version is the one recorded, or older. */
  | "plugin-unchanged"
  /**
   * The tag names one release, or one signalk-container does not move.
   * Nothing is recorded, so a later switch to a floating tag is checked.
   */
  | "tag-not-floating"
  /**
   * signalk-container is older than 1.38.0 and cannot tell whether
   * signalk-internet reports a free link. On a newer one the check waits on
   * a restricted link, asking again every `linkRetryMs`, instead.
   */
  | "link-restricted"
  | "up-to-date"
  | "updated"
  /**
   * `update()` resolved true, but within `versionWaitMs` the container
   * reports an older release than the latest, or no version. Its tag may
   * never reach that release (a bare major such as `9`, a `stable` line
   * behind the latest), the registry may not carry it yet, or the container
   * may start slower. Recorded all the same: checking again would recreate
   * the container at every start.
   */
  | "behind-after-update"
  /** `update()` resolved false. */
  | "not-applied"
  /**
   * The signal aborted. Recorded where `update()` had applied an update by
   * then; the next start then finds the plugin version unchanged.
   */
  | "aborted";

/**
 * After your plugin was updated, bring a container on a floating tag to the
 * latest release once, where it runs an older one. A first start, with no
 * state file yet, counts as an update.
 *
 * Start it without awaiting it once your container has started (after
 * `container.start()` resolved), since `update()` takes your lifecycle lock.
 * It waits for a free link and for both versions, asking again every
 * `linkRetryMs`, so it can stay pending for as long as the link stays
 * metered, offline or captive. Without signalk-internet enabled the link
 * counts as free; signalk-container older than 1.38.0 cannot tell, and the
 * check ends as `link-restricted`.
 *
 * The plugin version is recorded once the container needs no update, or
 * once `update()` has applied one; an `update()` that resolves false records
 * nothing, so the next start checks again. Before `update()` runs, the state
 * file is written once, so a file that cannot be written rejects before any
 * recreate. An invalid `pluginVersion` or duration, errors thrown by
 * `update()` (unless the signal aborted) and errors writing the state file
 * reject; errors reading a version or asking for the link are tried again.
 */
export async function updateImageAfterPluginUpdate(
  options: ImageAfterPluginUpdateOptions,
): Promise<ImageAfterPluginUpdateOutcome> {
  const { manager, pluginVersion, stateFile, signal } = options;
  if (!isVersion(pluginVersion)) {
    // Recorded, it would read back as no record and recheck at every start.
    throw new Error(`Not a plugin version: "${options.pluginVersion}"`);
  }
  // At least 1 ms: a wait of 0 lets the server's plugin-list read run
  // unbounded, past an abort.
  const linkWaitMs = duration("linkWaitMs", options.linkWaitMs, 1);
  const linkRetryMs = duration("linkRetryMs", options.linkRetryMs, 1);
  const versionWaitMs = duration("versionWaitMs", options.versionWaitMs, 0);
  const checked = await readCheckedVersion(stateFile);
  if (checked !== null && !isLaterVersion(pluginVersion, checked)) {
    return "plugin-unchanged";
  }
  if (classifyTag(options.tag) !== "floating") return "tag-not-floating";

  const internet = manager.internet;
  if (!internet) return "link-restricted";
  const linkFree = async (waitMs: number) =>
    !((await orNull(() => internet.isRestricted({ waitMs, signal }))) ?? true);
  const record = () => recordCheckedVersion(stateFile, pluginVersion);
  let running: string | null;
  let latest: string | null;
  for (let first = true; ; first = false) {
    if (!first && !(await delay(linkRetryMs ?? DEFAULT_LINK_RETRY_MS, signal)))
      return "aborted";
    const free = await linkFree(
      first ? (linkWaitMs ?? DEFAULT_LINK_WAIT_MS) : RETRY_LINK_WAIT_MS,
    );
    if (signal.aborted) return "aborted";
    if (!free) continue;
    running = asVersion(await orNull(options.currentVersion));
    if (signal.aborted) return "aborted";
    if (!running) continue;
    latest = asVersion(
      await orNull(() => latestVersion(manager, options.versionSource)),
    );
    if (signal.aborted) return "aborted";
    if (!latest) continue;
    if (!isLaterVersion(latest, running)) {
      await record();
      return "up-to-date";
    }
    // Reading the versions takes a while; the link may have turned metered
    // since, and the pull is the download that must not run on one.
    const stillFree = await linkFree(RETRY_LINK_WAIT_MS);
    if (signal.aborted) return "aborted";
    if (stillFree) break;
  }

  // Found unwritable only after the recreate, the file would let every
  // start recreate again.
  await writeState(
    stateFile,
    checked === null ? {} : { pluginVersion: checked },
  );
  if (signal.aborted) return "aborted";
  let applied: boolean;
  try {
    applied = await options.update(signal);
  } catch (err) {
    if (signal.aborted) return "aborted";
    throw err;
  }
  if (!applied) return signal.aborted ? "aborted" : "not-applied";
  await record();
  const now = await versionAfterUpdate(
    options.currentVersion,
    latest,
    versionWaitMs ?? DEFAULT_VERSION_WAIT_MS,
    signal,
  );
  if (signal.aborted) return "aborted";
  return now && !isLaterVersion(latest, now)
    ? "updated"
    : "behind-after-update";
}

async function latestVersion(
  manager: ContainerManagerApi,
  spec: VersionSourceSpec,
): Promise<string | null> {
  const runtime = manager.getRuntime();
  if (!runtime) return null;
  const result = await buildVersionSource(manager.updates, spec).fetch(runtime);
  return result.kind === "version" ? result.latest : null;
}

/**
 * Asks `read` until it reports `latest` or later, for up to `waitMs`, and
 * returns the last version it reported, if any: a container that answers
 * before the recreate took effect may still report the release it ran.
 */
async function versionAfterUpdate(
  read: () => Promise<string | null>,
  latest: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  // A monotonic clock: a boat's wall clock may jump with GPS or NTP.
  const deadline = performance.now() + waitMs;
  let last: string | null = null;
  for (;;) {
    if (signal.aborted) return last;
    last = asVersion(await orNull(read)) ?? last;
    if (last && !isLaterVersion(latest, last)) return last;
    const left = deadline - performance.now();
    if (left <= 0) return last;
    if (!(await delay(Math.min(VERSION_POLL_MS, left), signal))) return last;
  }
}

/**
 * A duration option: undefined when not given, else a finite number of at
 * least `min` ms, capped at what setTimeout keeps.
 */
function duration(
  name: string,
  value: number | undefined,
  min: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < min) {
    // NaN, Infinity or a negative delay would make setTimeout fire at once.
    throw new Error(`${name} must be a number of at least ${min} ms`);
  }
  return Math.min(value, MAX_DELAY_MS);
}

/** Resolves true after `ms`, or false once `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    // `ms` comes through duration(), which caps it at what setTimeout keeps.
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `read`, taking a throw or a rejection for an unknown value. */
async function orNull<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function readCheckedVersion(file: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      pluginVersion?: unknown;
    };
    // Anything but a version is taken for no record, so the check runs.
    return asVersion(parsed.pluginVersion);
  } catch {
    return null;
  }
}

function recordCheckedVersion(
  file: string,
  pluginVersion: string,
): Promise<void> {
  return writeState(file, { pluginVersion });
}

let writes = 0;

/**
 * Writes and renames, so a power cut leaves the old record or the new. The
 * temp name is the write's own, so two checks writing at once cannot rename
 * each other's file away.
 */
async function writeState(
  file: string,
  state: { pluginVersion?: string },
): Promise<void> {
  const temp = `${file}.${process.pid}.${++writes}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state) + "\n");
    await rename(temp, file);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

const IDENTIFIERS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const VERSION = new RegExp(
  `^v?\\d+(?:\\.\\d+)*(?:-${IDENTIFIERS})?(?:\\+${IDENTIFIERS})?$`,
  "i",
);

/**
 * Whether `value` is a semver-style version: a dotted number such as
 * `9.4.3` or `v10`, with an optional `-` pre-release or `+` build after it.
 */
function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value.trim());
}

function asVersion(value: unknown): string | null {
  return isVersion(value) ? value : null;
}

/**
 * Whether `a` is a later version than `b`, by semver precedence: a leading
 * `v` and build metadata (`+build5`) are ignored, missing parts count as 0
 * (`9.4` equals `9.4.0`), and a release is later than its pre-releases
 * (`2.4.0-beta.1`). Pre-releases compare part by part, numbers numerically
 * and below names, and a longer one is later than its own prefix
 * (`1.0.0-alpha.1` after `1.0.0-alpha`).
 */
export function isLaterVersion(a: string, b: string): boolean {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const byCore = compareCore(coreA, coreB);
  if (byCore !== 0) return byCore > 0;
  if (preA === null || preB === null) return preA === null && preB !== null;
  return comparePreRelease(preA, preB) > 0;
}

function splitVersion(version: string): [string[], string[] | null] {
  const v = version.trim().replace(/^v/i, "").replace(/\+.*$/, "");
  const dash = v.indexOf("-");
  const core = (dash < 0 ? v : v.slice(0, dash)).split(".");
  return [core, dash < 0 ? null : v.slice(dash + 1).split(".")];
}

function isNumeric(part: string): boolean {
  return /^\d+$/.test(part);
}

function compareIdentifiers(pa: string, pb: string): number {
  if (isNumeric(pa) && isNumeric(pb)) return Number(pa) - Number(pb);
  if (isNumeric(pa) !== isNumeric(pb)) return isNumeric(pa) ? -1 : 1;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

function compareCore(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const order = compareIdentifiers(a[i] ?? "0", b[i] ?? "0");
    if (order !== 0) return order;
  }
  return 0;
}

function comparePreRelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIdentifiers(a[i] ?? "", b[i] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}
