/**
 * Canonical TypeScript mirror of signalk-container's public API surface.
 *
 * signalk-container is a runtime-only dependency: consumer plugins must NOT
 * import it at compile time or declare it in npm dependencies/peerDependencies
 * (its prerelease versioning breaks npm semver ranges). The coupling happens
 * exclusively through `globalThis.__signalk_containerManager`, declared at the
 * bottom of this file. Declare the relationship in package.json instead:
 *
 *   "signalk": { "requires": ["signalk-container"] }
 *
 * Source of truth: https://github.com/dirkwa/signalk-container
 *   (src/types.ts and src/updates/types.ts)
 * Last synced against signalk-container: v1.25.5 (the contract test compiles
 * against whatever the devDependency resolves to, so this line records the
 * version the JSDoc prose was last read against — the part no test checks)
 * Supported baseline: v1.6.0 — members newer than the baseline are optional
 * here so call sites are forced to feature-detect. Version floors are noted
 * on each member.
 */

export type RuntimeName = "podman" | "docker";

export interface ContainerRuntimeInfo {
  runtime: RuntimeName;
  version: string;
  /** @deprecated Always `false` since the move to the socket client. */
  isPodmanDockerShim?: boolean;
  /** cgroup v2 controllers available to this runtime; `null` = not probed. */
  cgroupControllers?: string[] | null;
  /** Whether the runtime operates rootless; `null` = not probed. */
  isRootless?: boolean | null;
  /** Effective host uid/gid of the Signal K process; `null` on Windows. */
  hostUser?: { uid: number; gid: number } | null;
  /** Unix socket the runtime client resolved to (diagnostic). */
  socketPath?: string;
}

export type ContainerState = "running" | "stopped" | "missing" | "no-runtime";

/**
 * Per-volume policy when the host source path is missing at create time.
 * Named volumes (no leading `/` or `.`) always pass through.
 */
/** What {@link ContainerManagerApi.probeHostDevice} found. */
export interface HostDeviceProbeResult {
  /** The path exists on the host and holds at least one device node. */
  exists: boolean;
  /** Device node names found there, sorted. */
  nodes: string[];
  /** Host group names owning them, sorted; numeric gid when unnamed. */
  groups: string[];
}

export interface VolumeSpec {
  /** Host path or named-volume string — same shape as the bare-string form. */
  source: string;
  /**
   * - `'create'` (default): runtime creates the host dir. Plugin state dirs.
   * - `'skip'`: drop the mount when missing. Optional USB/NFS mounts.
   * - `'abort'`: throw from ensureRunning. Required mounts (certs, secrets).
   */
  ifMissing?: "create" | "skip" | "abort";
  /**
   * Bind the volume read-only. Default false.
   *
   * For a directory owned by ANOTHER component — charts published by a chart
   * provider, say — this keeps the consuming container from writing into it.
   * signalk-container 1.30.0+; silently ignored by older versions.
   */
  readOnly?: boolean;
}

/** Event delivered to `EnsureRunningOptions.onVolumeIssue`. */
export interface VolumeIssue {
  containerPath: string;
  source: string;
  action: "skipped" | "aborted" | "recovered";
  reason: string;
}

/** Event delivered to `EnsureRunningOptions.onUlimitClamped` (1.17.0+). */
export interface UlimitClamp {
  ulimit: string;
  requested: number;
  granted: number;
  reason: string;
}

/** Event delivered to `EnsureRunningOptions.onResourceClamped` (1.28.1+). */
export interface ResourceClamp {
  /** The limit that was clamped; currently only `"cpus"`. */
  resource: "cpus";
  requested: number;
  granted: number;
  reason: string;
}

/**
 * Event delivered to `EnsureRunningOptions.onContainerWedged` (1.29.0+): a
 * drift recreate was deferred because the runtime cannot stop or remove the
 * live container (a permission error — typically an orphaned rootless-Podman
 * user namespace after a Podman service restart). Fired once per wedge; the
 * `reason` carries the operator remedy, so surface it via `setPluginError`.
 */
export interface ContainerWedged {
  /** Managed name as passed to `ensureRunning` (before the `sk-` prefix). */
  name: string;
  /** What prompted the recreate, e.g. `"networkMode"` or `"nofile N → M"`. */
  drift: string;
  /** Human-readable explanation with remediation; safe for `setPluginError`. */
  reason: string;
}

/**
 * Explicit healthcheck for a managed container (config field is 1.14.0+;
 * silently ignored by older versions). `false` emits `--no-healthcheck`.
 */
export type HealthcheckOverride =
  | false
  | {
      /** Docker HEALTHCHECK array form: ["CMD", ...] or ["CMD-SHELL", "<shell>"]. */
      test: string[];
      /** e.g. "30s" — durations are passed to the runtime verbatim. */
      interval?: string;
      timeout?: string;
      /** Grace period before failures count, e.g. "15s". */
      startPeriod?: string;
      retries?: number;
    };

/**
 * Resource limits applied via podman/docker run flags. Omitted = no limit;
 * `null` in a user override explicitly removes a plugin-set limit.
 */
export interface ContainerResourceLimits {
  /** Hard CPU cap (CFS quota), e.g. 1.5 = 1.5 cores. */
  cpus?: number | null;
  /** Soft CPU weight under contention (default 1024). */
  cpuShares?: number | null;
  /** Pin to specific cores, e.g. "0,1" or "1-3". */
  cpusetCpus?: string | null;
  /** Hard memory cap, e.g. "512m", "2g". */
  memory?: string | null;
  /** Total memory + swap; set equal to `memory` to disable swap. */
  memorySwap?: string | null;
  /** Soft floor — kernel reclaims from containers above this first. */
  memoryReservation?: string | null;
  /** Process/thread cap. */
  pidsLimit?: number | null;
  /** OOM score adjustment, -1000..1000. Higher = killed first. */
  oomScoreAdj?: number | null;
}

/**
 * Declarative desired state for a managed container. Pass the same config to
 * `ensureRunning` on every plugin start — signalk-container diffs it against
 * the live container and removes + recreates when `image`, `tag`, `command`,
 * `networkMode`, `env`, `volumes`, `ports`, `devices`, or `groupAdd` differ.
 * `restart`, `labels`, `healthcheck`, and `ulimits` are NOT part of drift
 * detection.
 */
export interface ContainerConfig {
  /** Image repo without tag, e.g. "ghcr.io/questdb/questdb". */
  image: string;
  tag: string;
  /** Manifest digest ("sha256:<64-hex>"); pulls `image@digest` when set. */
  digest?: string;
  /** Update channel: "tag:<pattern>" | "tag:latest" | "digest:explicit". */
  updateChannel?: string;
  /**
   * When true and `tag` is floating (latest/main/edge/…), every
   * ensureRunning pulls and recreates on digest drift. Offline pull
   * failures are silently skipped. 1.9.0+.
   */
  autoUpdateOnFloatingTag?: boolean;
  /** "containerPort/proto" → "hostIp:hostPort". Ignored with networkMode. */
  ports?: Record<string, string>;
  /** container path → host path | named volume | VolumeSpec. */
  volumes?: Record<string, string | VolumeSpec>;
  /**
   * Mount **signalk-container's own** Signal K data dir at this container
   * path. Signal K rewrites `app.getDataDirPath()` per plugin, and the
   * manager resolves this field from *its* app object — so a consumer
   * plugin setting this gets `<configRoot>/plugin-config-data/signalk-container/`,
   * NOT its own data dir. Useful only as a private writable area inside the
   * Signal K data tree.
   *
   * To mount your own plugin's data dir, use `resolveMount()` with your
   * `app.getDataDirPath()` and pass the result as a plain `volumes` entry.
   *
   * The host-side source is resolved automatically for bare-metal and
   * containerized Signal K deployments.
   */
  signalkDataMount?: string;
  /**
   * Mount the whole Signal K config root (`app.config.configPath`, typically
   * `~/.signalk`) here — the entire installation config, including
   * `security.json` and every plugin's `plugin-config-data/` subdirectory.
   * Unlike `signalkDataMount` this is NOT per-plugin: Signal K does not
   * rewrite `configPath`, so every caller gets the same tree. Prefer
   * `resolveMount()` when you only need your own plugin's directory.
   *
   * Throws if the caller's `app` lacks `config.configPath`. 1.5.0+.
   */
  signalkConfigRootMount?: string;
  /**
   * Container ports the Signal K process must reach back into; networking
   * strategy is chosen automatically. Read the result with
   * `resolveContainerAddress()` after `ensureRunning()`.
   */
  signalkAccessiblePorts?: number[];
  env?: Record<string, string>;
  /** Defaults to "unless-stopped" when omitted. */
  restart?: "no" | "unless-stopped" | "always";
  /**
   * Set consistently across calls: toggling between an explicit command and
   * undefined looks like drift on every ensureRunning.
   */
  command?: string[];
  networkMode?: string;
  /** hostname → IP (or "host-gateway") entries for /etc/hosts. */
  extraHosts?: Record<string, string>;
  /**
   * Host-UID ownership mapping. Omit for the default (image runs as root,
   * files on bind mounts owned by the Signal K user). Set
   * `{ inImageUid, inImageGid }` when the image declares a non-root USER.
   * `false` opts out entirely.
   */
  user?: { inImageUid?: number; inImageGid?: number } | false;
  /**
   * Host devices to expose. Two entry forms:
   *   - device NODE path, docker `--device` syntax
   *     `hostPath[:containerPath[:permissions]]` — attached statically at
   *     create time; a replugged node reappears only on the next recreate.
   *   - device DIRECTORY path, e.g. "/dev/snd" — hot-plug mode: bind-mounted
   *     at the same path with device-class cgroup rules opened, so nodes
   *     appearing after a USB replug stay visible. Use for USB audio,
   *     input devices, GPUs.
   * An entry whose host path is missing is skipped with a warning — an
   * unplugged device never prevents container start. On rootless runtimes
   * access is governed by plain file permissions on the bound nodes —
   * combine with `groupAdd` to hold the device group. Part of drift
   * detection. 1.24.0+ — silently ignored by older versions.
   */
  devices?: string[];
  /**
   * Supplementary groups (`--group-add`): group names or numeric GIDs.
   * Names are resolved to GIDs against the HOST's /etc/group (it is the
   * host GID the kernel checks on host device nodes, and the runtimes
   * would resolve names against the image's /etc/group instead); a name
   * unknown to the host is skipped with a warning. On rootless Podman the
   * `run.oci.keep_original_groups` annotation is additionally emitted so
   * the container process keeps the host user's own supplementary groups —
   * `groupAdd: ["audio"]` + `devices: ["/dev/snd"]` then works across
   * docker and rootful/rootless podman alike. Part of drift detection.
   * 1.24.0+ — silently ignored by older versions.
   */
  groupAdd?: (string | number)[];
  /** Plugin-default resource limits; users override per-field. */
  resources?: ContainerResourceLimits;
  /**
   * Per-process ulimits, e.g. `{ nofile: 1048576 }`. `nofile` is clamped
   * to the host ceiling (see onUlimitClamped). 1.17.0+ (ignored earlier).
   */
  ulimits?: Record<string, number | { soft: number; hard: number }>;
  /** Informational labels (not drift-detected). */
  labels?: Record<string, string>;
  /** Explicit healthcheck override. 1.14.0+ (ignored earlier). */
  healthcheck?: HealthcheckOverride;
}

export interface ContainerInfo {
  /** Full name as the runtime sees it, e.g. "sk-questdb". */
  name: string;
  /**
   * `name` with the namespace prefix removed, e.g. "questdb" — the form
   * consumer plugins pass to ensureRunning. The namespace is "sk" only by
   * default (configurable via SIGNALK_CONTAINER_NAMESPACE), so this is the
   * only reliable key for matching a container by its unprefixed name.
   * Present in every signalk-container that supports namespacing; when
   * absent (a very old version), fall back to a namespace-agnostic
   * name-suffix match rather than assuming an "sk-" prefix.
   */
  unprefixedName?: string;
  image: string;
  state: ContainerState;
  created?: string;
  /** e.g. ["127.0.0.1:3010->3010/tcp"] */
  ports?: string[];
  managedBy?: string;
}

/** Options bag accepted by `ensureRunning` / `recreate`. */
export interface EnsureRunningOptions {
  /** Custom app-level health probe (legacy HealthCheckOptions). */
  healthCheck?: () => Promise<boolean>;
  onUnhealthy?: (name: string, error: string) => void;
  /** Fires for volume skip/abort/recovery events. Never awaited. */
  onVolumeIssue?: (event: VolumeIssue) => void | Promise<void>;
  /** Stream the container's stdout/stderr lines (1.7.0+). Never awaited. */
  onContainerLog?: (line: string) => void | Promise<void>;
  /** Backfill the last N lines when (re)attaching the log stream. */
  onContainerLogStartTail?: number;
  /** Fired when a requested ulimit was lowered to the host ceiling (1.17.0+). */
  onUlimitClamped?: (event: UlimitClamp) => void;
  /** Fired when a `cpus` cap was lowered to the daemon's CPU count (1.28.1+). */
  onResourceClamped?: (event: ResourceClamp) => void;
  /**
   * Fired once when a drift recreate is deferred because the runtime cannot
   * stop or remove the container (orphaned rootless userns / permission).
   * Surface via `setPluginError`; the container needs out-of-band recovery
   * (1.29.0+).
   */
  onContainerWedged?: (event: ContainerWedged) => void;
  /** npm package name — opt-in to digest pinning manifests. */
  pluginId?: string;
  pluginVersion?: string;
}

export interface ContainerJobConfig {
  image: string;
  command: string[];
  /** Override the image's baked ENTRYPOINT. */
  entrypoint?: string[];
  /** container path → host path, mounted read-only. */
  inputs?: Record<string, string>;
  /** container path → host path, mounted read-write. */
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  /** Seconds. */
  timeout?: number;
  onProgress?: (msg: string) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  resources?: ContainerResourceLimits;
  label?: string;
  /** Strongly recommended: enables cleanupOrphanedJobs reaping (1.3.0+). */
  ownerPluginId?: string;
  user?: { inImageUid?: number; inImageGid?: number } | false;
  /** Cancel mid-run; resolves with status "cancelled" (1.16.0+). */
  signal?: AbortSignal;
}

export type ContainerJobStatus =
  "pending" | "pulling" | "running" | "completed" | "failed" | "cancelled";

export interface ContainerJobResult {
  id: string;
  status: ContainerJobStatus;
  image: string;
  command: string[];
  label?: string;
  exitCode?: number;
  log: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  runtime?: RuntimeName;
}

export interface PruneResult {
  imagesRemoved: number;
  spaceReclaimed: string;
}

export interface OrphanJobInfo {
  name: string;
  image: string;
  ownerPluginId: string;
  label?: string;
}

export interface CleanupOrphansResult {
  reaped: OrphanJobInfo[];
}

export interface UpdateResourcesResult {
  method: "live" | "recreated";
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Update-detection service (containers.updates)
// ---------------------------------------------------------------------------

export type VersionSourceResult =
  | { kind: "version"; latest: string; metadata?: Record<string, unknown> }
  | { kind: "digest"; remoteDigest: string }
  | { kind: "error"; error: string };

/** Pluggable "latest available version" strategy. Built via `updates.sources`. */
export interface VersionSource {
  fetch(runtime: ContainerRuntimeInfo): Promise<VersionSourceResult>;
}

export interface UpdateRegistration {
  /** Registration key — your plugin id. */
  pluginId: string;
  /** Container name as passed to ensureRunning (unprefixed). */
  containerName: string;
  /** Image repo without tag. */
  image: string;
  /**
   * MUST be a function (not a captured value) so live config edits are
   * picked up without re-registering.
   */
  currentTag: () => string;
  versionSource: VersionSource;
  /**
   * Query the running container for its version directly; when non-null it
   * takes precedence over currentTag() for the comparison.
   */
  currentVersion?: () => Promise<string | null>;
  /** e.g. "24h" (default), "1h" minimum. */
  checkInterval?: string;
}

export type UpdateReason =
  | "newer-version"
  | "digest-drift"
  | "older-than-pinned"
  | "up-to-date"
  | "offline"
  | "unknown"
  | "error";

export type TagKind = "semver" | "floating" | "unknown";

export interface UpdateCheckResult {
  pluginId: string;
  containerName: string;
  runningTag: string;
  tagKind: TagKind;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  reason: UpdateReason;
  error?: string;
  checkedAt: string;
  lastSuccessfulCheckAt: string | null;
  /** True when reason === "offline" and cached data was returned. */
  fromCache: boolean;
}

export interface UpdateServiceApi {
  register(reg: UpdateRegistration): void;
  unregister(pluginId: string): void;
  checkOne(pluginId: string): Promise<UpdateCheckResult>;
  checkAll(): Promise<UpdateCheckResult[]>;
  getLastResult(pluginId: string): UpdateCheckResult | null;
  sources: {
    githubReleases(
      repo: string,
      options?: {
        allowPrerelease?: boolean;
        tagPrefix?: string;
        token?: string;
      },
    ): VersionSource;
    dockerHubTags(
      image: string,
      options?: { filter?: (tag: string) => boolean },
    ): VersionSource;
  };
}

// ---------------------------------------------------------------------------
// Image-pinning manifests (containers.manifest) — 1.13.0+
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  ts: string;
  from: string | null;
  to: string;
  reason:
    | "plugin-install"
    | "plugin-update"
    | "user-pull"
    | "auto-update"
    | "manual-check";
  triggeredBy?: string;
}

export interface ConsumerManifest {
  schemaVersion: 1;
  pluginId: string;
  pluginVersion: string;
  registeredAt: string;
  containers: Record<
    string,
    {
      image: string;
      declaredTag: string;
      declaredDigest: string | null;
      resolvedDigest: string;
      resolvedAt: string;
      updateChannel: string;
      history: HistoryEntry[];
    }
  >;
}

export interface ManifestApi {
  get(pluginId: string): Promise<ConsumerManifest | null>;
  list(): Promise<ConsumerManifest[]>;
  getContainerHistory(containerName: string): Promise<HistoryEntry[]>;
}

// ---------------------------------------------------------------------------
// Doctor probes (containers.doctor) — 1.8.0+
// ---------------------------------------------------------------------------

export type SelfDeploymentStatus =
  | "ok"
  | "no-runtime"
  | "socket-unreachable"
  | "permission-denied"
  | "self-id-unresolved"
  | "cgroup-controllers-incomplete";

/**
 * Verdict from `DoctorApi.selfDeployment()`.
 *
 * Mirrored in full. It previously carried only `status`/`remediation` behind
 * an index signature, which typed every other field as `unknown` while
 * looking complete — a consumer reading `isContainerized` (the field the
 * probe exists for) got no error and no value.
 */
/**
 * Recognised host platform marker (signalk-container 1.26.0+). Currently only
 * HaLOS is detected; `null`/absent means an unrecognised or generic host.
 */
export type HostPlatform = "halos";

export interface SelfDeploymentResult {
  /** True when /.dockerenv, /run/.containerenv, or `$container` is set. */
  isContainerized: boolean;
  /**
   * Recognised host platform, or `null` when no marker matched. Optional —
   * payloads from older servers omit it (treat absent as `null`).
   */
  platform?: HostPlatform | null;
  binary: {
    name: RuntimeName | null;
    path: string | null;
    version: string | null;
  };
  daemon: {
    reachable: boolean;
    rootless: boolean | null;
    socketPath: string | null;
    error: string | null;
  };
  env: {
    DOCKER_HOST: string | null;
    CONTAINER_HOST: string | null;
    XDG_RUNTIME_DIR: string | null;
  };
  selfId: {
    value: string | null;
    source: "env" | "hostname" | "cgroup" | null;
  };
  cgroupControllers: {
    available: string[] | null;
    missing: string[];
    kernelDisabledMemory: boolean;
  };
  containerStorage: {
    storagePath: string | null;
    fstype: string | null;
    idmapHazard: boolean;
    advice: string[];
  } | null;
  linger: {
    user: string | null;
    enabled: boolean;
    advice: string[];
  } | null;
  devicePassthrough?: {
    issues: Array<{
      container: string;
      entry: string;
      hostPath: string;
      action: "skipped" | "optimistic" | "unresolved" | "group-skipped";
      reason: string;
    }>;
    advice: string[];
  } | null;
  networkDns: {
    backend: string | null;
    helperPath: string | null;
    dnsBroken: boolean;
    advice: string[];
  } | null;
  status: SelfDeploymentStatus;
  /** Copy-pasteable remediation lines for failure statuses. */
  remediation: string[];
}

export interface SetupSnippetResult {
  snippet: string;
  dockerfile?: string;
  notes?: string[];
}

export interface DoctorApi {
  /** Probe an image under the host-UID mapping. Never throws (1.8.0+). */
  imageRunsAsUser(
    image: string,
    user?: { inImageUid?: number; inImageGid?: number } | false,
  ): Promise<{ ok: boolean; output: string; error?: string }>;
  /** Diagnose the Signal K deployment itself. Never throws (1.9.0+). */
  selfDeployment(): Promise<SelfDeploymentResult>;
  /** Templated compose/run snippet for socket wiring (1.10.0+). */
  generateSetupSnippet(
    format?: "compose" | "run",
    result?: SelfDeploymentResult,
  ): Promise<SetupSnippetResult>;
}

// ---------------------------------------------------------------------------
// The manager object published on globalThis
// ---------------------------------------------------------------------------

/** Soft/hard nofile limits observed on a running container. */
export interface NofileLimits {
  soft: number;
  hard: number;
}

export interface ContainerManagerApi {
  /** Detected runtime, or null while detection is in flight / failed. */
  getRuntime(): ContainerRuntimeInfo | null;
  /**
   * Resolves once runtime detection settles (success OR failure) — re-check
   * `getRuntime()` afterwards to tell the two apart. 1.6.0+.
   */
  whenReady(): Promise<void>;
  /** `image` is the joined "repo:tag" form here (unlike ContainerConfig). */
  pullImage(image: string, onProgress?: (msg: string) => void): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  /** Local sha256 image id for an image ref or container name. 1.6.0+. */
  getImageDigest(imageOrContainer: string): Promise<string | null>;
  /**
   * Idempotent declarative reconcile: create+start if missing, start if
   * stopped, remove+recreate on config drift.
   */
  ensureRunning(
    name: string,
    config: ContainerConfig,
    options?: EnsureRunningOptions,
  ): Promise<void>;
  /**
   * Force-recreate regardless of drift detection ("update now", startup
   * self-heal). 1.12.0+ — feature-detect.
   */
  recreate?(
    name: string,
    config: ContainerConfig,
    options?: EnsureRunningOptions,
  ): Promise<void>;
  start(name: string): Promise<void>;
  /** Idempotent. */
  stop(name: string): Promise<void>;
  /** Stops and removes. Idempotent. */
  remove(name: string): Promise<void>;
  /**
   * Remove a container AND its bind-mount data dir, handling the
   * rootless-Podman subuid ownership trap. The path must sit under the
   * calling context's `app.getDataDirPath()` or below; empty paths and
   * filesystem roots are refused. 1.18.0+ — feature-detect.
   */
  removeManagedData?(
    name: string,
    hostPath: string,
    options?: { ownerPluginId?: string },
  ): Promise<void>;
  getState(name: string): Promise<ContainerState>;
  /** Lists managed (namespace-prefixed) containers. */
  listContainers(): Promise<ContainerInfo[]>;
  /** Live-update resource limits, falling back to recreate. */
  updateResources(
    name: string,
    limits: ContainerResourceLimits,
  ): Promise<UpdateResourcesResult>;
  /** Effective merged limits ({} when untracked). */
  getResources(name: string): ContainerResourceLimits;
  /**
   * host:port (or container-name:port) for a port declared via
   * `signalkAccessiblePorts`, after ensureRunning.
   */
  resolveContainerAddress(
    containerName: string,
    containerPort: number,
  ): Promise<string | null>;
  /**
   * Host source backing **signalk-container's own** `app.getDataDirPath()` —
   * the same value `signalkDataMount` resolves to, and equally NOT the
   * calling plugin's data dir. Takes no plugin id and cannot be scoped to
   * one; use `resolveMount()` for your own directory.
   */
  resolveSignalkDataMount?(): Promise<string | null>;
  /**
   * Whether a device path exists on the HOST, and which groups own its nodes.
   *
   * A plugin cannot answer this itself: `stat()` describes the plugin's own
   * filesystem, which is the Signal K container whenever Signal K is
   * containerized — `/dev/dri` is absent there even on a machine with a GPU.
   *
   * `groups` are NAMES, which is what `groupAdd` wants: the gid of
   * `render`/`video` differs per distro, so a hardcoded number loses access
   * elsewhere. Null means **unknown**, deliberately distinct from
   * `{ exists: false }`. signalk-container 1.30.0+ — feature-detect, or use
   * the `probeHostDevice()` helper which does it for you.
   */
  probeHostDevice?(path: string): Promise<HostDeviceProbeResult | null>;
  /**
   * Translate an absolute path to the (source, subPath) mountable by the
   * host runtime. Null when unreachable. 1.7.0+ — feature-detect.
   */
  resolveHostPath?(
    absPath: string,
  ): Promise<{ source: string; subPath: string } | null>;
  /** Run a one-shot helper container to completion. */
  runJob(config: ContainerJobConfig): Promise<ContainerJobResult>;
  /** Last N lines of combined stdout/stderr. 1.7.0+ — feature-detect. */
  getLogs?(
    name: string,
    options?: { tail?: number; since?: number },
  ): Promise<string[]>;
  /**
   * The nofile limits the named container is ACTUALLY running with, or null
   * when it does not exist or neither source is readable (a containerized
   * Signal K without pid-namespace access). Treat null as "unknown", never as
   * a limit.
   *
   * Use it to verify that a previously reported ulimit clamp still reflects
   * reality — e.g. to clear a "capped by the host" advisory once the container
   * does run with the full requested limit. 1.25.3+ — feature-detect.
   */
  getContainerNofile?(name: string): Promise<NofileLimits | null>;
  /** Reap sk-job-* containers leaked by a crash. 1.3.0+. */
  cleanupOrphanedJobs(filter: {
    ownerPluginId: string;
  }): Promise<CleanupOrphansResult>;
  prune(): Promise<PruneResult>;
  execInContainer?(
    name: string,
    command: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  ensureNetwork?(name: string): Promise<void>;
  removeNetwork?(name: string): Promise<void>;
  connectToNetwork?(containerName: string, networkName: string): Promise<void>;
  disconnectFromNetwork?(
    containerName: string,
    networkName: string,
  ): Promise<void>;
  updates: UpdateServiceApi;
  /** 1.13.0+ — feature-detect. */
  manifest?: ManifestApi;
  /** 1.8.0+ — feature-detect. */
  doctor?: DoctorApi;
}

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined;
}

/**
 * Minimal slice of the Signal K plugin `app` object the helpers need.
 * Status/error setters take ONE argument — the server pre-binds the plugin id.
 */
export interface AppLike {
  debug: (msg: string) => void;
  error?: (msg: string) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
}
