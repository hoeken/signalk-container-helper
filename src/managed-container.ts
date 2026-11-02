import type {
  AppLike,
  ContainerConfig,
  ContainerInfo,
  ContainerManagerApi,
  ContainerState,
  ContainerStateDetail,
  EnsureRunningOptions,
  UpdateCheckResult,
} from "./types.js";
import { getContainerManager, waitForContainerManager } from "./manager.js";
import {
  buildVersionSource,
  type VersionSourceSpec,
} from "./version-source.js";
import { waitForHttpReady, type FetchLike } from "./http.js";
import { anySignal, retryForever, type RetryForeverOptions } from "./retry.js";
import {
  matchContainerInfo,
  resolveContainerEndpoint,
} from "./resolve-address.js";
import {
  canonicalImageRef,
  ContainerHelperError,
  errMsg,
  isValidImageTag,
  throwIfAborted,
} from "./util.js";

/**
 * The plugin ids signalk-container's manifest accepts: an npm package name or
 * a scoped one, lowercase (its `PLUGIN_ID_RE`, less the synthetic form).
 */
const MANIFEST_PLUGIN_ID =
  /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;

export interface ReadinessOptions {
  /**
   * Container port to reach the app on — must also be declared in the
   * config's `signalkAccessiblePorts` so signalk-container wires networking.
   */
  port: number;
  /** Health path polled on the resolved address. Default "/". */
  path?: string;
  /** Overall readiness deadline. Default 60_000. */
  maxMs?: number;
  /** Poll interval. Default 1_000. */
  intervalMs?: number;
  /** Per-request timeout. Default 2_000. */
  requestTimeoutMs?: number;
}

export interface ManagedUpdateOptions {
  versionSource: VersionSourceSpec;
  /**
   * Live getter for the currently-configured tag. Defaults to a getter of
   * the tag most recently passed to start()/applyUpdate() (falling back to
   * `defaultTag`). Provide your own when the user can edit the tag in the
   * plugin options without restarting.
   */
  currentTag?: () => string;
  /** Query the running app for its version; preferred over currentTag. */
  currentVersion?: () => Promise<string | null>;
  /** e.g. "24h" (default), "1h" minimum. */
  checkInterval?: string;
}

export interface ManagedContainerOptions {
  app: AppLike;
  /** Your plugin id (package.json name) — update-service registration key. */
  pluginId: string;
  /** Container name, unprefixed (signalk-container adds its namespace). */
  name: string;
  /** Image repo without tag, e.g. "ghcr.io/questdb/questdb". */
  image: string;
  /**
   * Build the full declarative ContainerConfig for a resolved tag. Called on
   * every start/update — keep it pure so drift detection sees stable input.
   */
  buildConfig: (tag: string) => ContainerConfig;
  /** Tag used when start() is called without one. Default "latest". */
  defaultTag?: string;
  /**
   * Map a user-facing tag to the tag actually run, e.g. "auto" → a pinned
   * tested version. Applied to start(), applyUpdate(), and route input.
   */
  resolveTag?: (requested: string) => string;
  /** Budget for waiting on signalk-container + runtime. Default 120_000. */
  managerTimeoutMs?: number;
  /** Poll interval while waiting for the manager global. Default 500. */
  managerPollIntervalMs?: number;
  /** HTTP readiness of the app inside the container (optional). */
  readiness?: ReadinessOptions;
  /**
   * Retry the whole bring-up indefinitely instead of throwing on the first
   * failure. Off by default: throwing once is the right shape for a plugin
   * that reports and waits for a human.
   *
   * Set it when nobody may be available to restart the plugin — the boat case,
   * where a transient boot race would otherwise leave the container down for
   * weeks. `start()` then resolves only on success or rejects on cancellation,
   * so pair it with `signal` and report progress via `onAttemptFailed`.
   *
   * Each attempt re-runs `start()` whole: `ensureRunning` is idempotent, and
   * the address is re-resolved every time because a container that only just
   * came up may bind a different host port.
   */
  readinessRetry?: RetryForeverOptions;
  /** Register with signalk-container's update-detection service (optional). */
  updates?: ManagedUpdateOptions;
  /**
   * Passed through to ensureRunning/recreate (onVolumeIssue, logs, …).
   * `pluginId` defaults to the `pluginId` above, so signalk-container records
   * which plugin owns the container; set it here to override.
   */
  ensureOptions?: EnsureRunningOptions;
  /** Suppress setPluginStatus progress lines. Default false. */
  quiet?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
}

/** Per-call options shared by the long-running lifecycle operations. */
export interface OperationOptions {
  /**
   * Cancels the operation.
   *
   * **Cooperative, not pre-emptive.** signalk-container's `ensureRunning`,
   * `recreate` and `stop` take no signal — only its one-off job API does — so
   * a call already in flight runs to completion. What this cancels is
   * everything around it: waiting for the manager global, the drift probe,
   * readiness polling, and each step boundary. In practice that is where the
   * time goes, since those are the polls with deadlines measured in minutes.
   *
   * Aborted operations reject with `ContainerHelperError` code `"cancelled"`,
   * already flagged as reported so `startSafely` logs it rather than putting
   * a plugin error on screen for something the caller asked for.
   */
  signal?: AbortSignal;
}

/** Options for {@link ManagedContainer.applyUpdate}. */
export interface ApplyUpdateOptions extends OperationOptions {
  /**
   * Pull the tag before the recreate. signalk-container's `recreate()` pulls
   * only an image missing from the host, so moving a container to a newer
   * image of a tag the host already has, such as `latest`, needs the pull;
   * the update route ({@link ManagedContainer.registerUpdateRoutes}) asks
   * for it, and a route of your own should too. Leave it off where the
   * recreate is not an update, such as after a device was plugged in: it
   * would download on any link and move the container to a newer image
   * nobody asked for. A config pinned to a digest is not pulled. Before
   * signalk-container 1.12.0 the update always pulls.
   *
   * Where the pull fails, the recreate goes ahead on the host's image of the
   * tag only if that is another image than the container runs (by image id)
   * or no container is listed: as on a rollback while offline, or where an
   * update check already pulled the new image. Where the host has the image
   * the container runs, or cannot tell, the update rejects with `pull-failed`
   * and leaves the container as it was.
   *
   * The pull runs before the update takes the lifecycle lock: signalk-container
   * cannot cancel a pull, and a `stop()` waiting for one would hold up the
   * plugin's restart for as long as the download takes. A `stop()` meanwhile
   * returns at once, and the update then stands down without recreating. A
   * recreate that pulls a missing image still runs under the lock.
   */
  pull?: boolean;
  /**
   * Apply only while the container is known to run this tag, as requested
   * from `start()` or an earlier update (before `resolveTag` maps it);
   * otherwise reject with `tag-mismatch` and change nothing. While a start or
   * update may be changing the container, and after one failed before the
   * container was up on its tag, the tag is unknown and matches no `ifTag`.
   * A start that brought the container up but never saw the app ready
   * (`not-ready`) leaves the tag known: the question is which tag, not
   * whether the app answers.
   *
   * Updates run one at a time in call order, and this is checked when the
   * update's turn comes, before its pull, so an update queued ahead of it
   * counts. It is checked again right before the recreate.
   *
   * Pass it where the tag was read a while ago and an operator may have moved
   * the container since with "Update now": the image check after a plugin
   * update (`updateImageAfterPluginUpdate`) can wait for days before its
   * update runs.
   */
  ifTag?: string;
}

/**
 * What `plugin.stop(options)` receives from a signalk-server that says why it
 * stops the plugin — forward that object to {@link ManagedContainer.stop}
 * unchanged.
 */
export interface StopOptions {
  /**
   * `shutdown` (the server is stopping) leaves the container running: a
   * shutdown is usually a server restart, the plugin's next start()
   * reconciles the container, and stopping it would only drop the service for
   * the length of the restart. Anything
   * else stops it — `disable`, `restart` (the new configuration may not want
   * a managed container at all), no reason (a server that does not pass one),
   * or a reason this version does not know.
   */
  reason?: string;
}

export interface StartResult {
  manager: ContainerManagerApi;
  /** The resolved tag that was started. */
  tag: string;
  /** "http://host:port" when readiness was configured, else null. */
  address: string | null;
}

/** Minimal router shape (Express-compatible) for registerUpdateRoutes. */
export interface RouterLike {
  get(
    path: string,
    handler: (req: unknown, res: ResponseLike) => unknown,
  ): unknown;
  post(
    path: string,
    handler: (req: unknown, res: ResponseLike) => unknown,
  ): unknown;
}

export interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

export interface UpdateRoutesOptions {
  /** Route prefix. Default "/api/update" (→ GET …/check, POST …/apply). */
  basePath?: string;
  /**
   * Called after a successful apply with the tag as requested by the client
   * (before resolveTag) and the tag actually run. Persist the REQUESTED tag
   * (e.g. "auto") via app.savePluginOptions here so auto-tracking survives.
   * Not called where the plugin stopped or restarted while the update ran:
   * its settings may have been saved meanwhile.
   */
  onApplied?: (
    requestedTag: string,
    resolvedTag: string,
  ) => void | Promise<void>;
}

/** Runs tasks one at a time, in the order they were queued. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queue `fn` behind any task already in flight. Both settlement paths
   * advance the queue, so one rejection cannot wedge every later task.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Full lifecycle wrapper for a plugin-owned ("managed") container — the
 * signalk-backup / mayara archetype. One instance per container.
 */
export class ManagedContainer {
  readonly options: ManagedContainerOptions;
  /** Resolved after start(); also lazily re-read from the global. */
  manager: ContainerManagerApi | undefined;
  /** Tag most recently started or applied (resolved form). */
  lastStartedTag: string | undefined;
  /** "http://host:port" once readiness resolved an address. */
  address: string | null = null;

  private updatesRegistered = false;
  /**
   * Serializes the lifecycle operations. Without it an overlapping
   * start/stop — a plugin restarted while its first start is still waiting on
   * readiness — interleaves ensureRunning and stop against the same container.
   * Every consumer plugin had built its own lock for this; it belongs here.
   */
  private readonly lifecycleQueue = new SerialQueue();
  /**
   * Serializes the updates among themselves, pull included, so they apply in
   * the order they were called. An update takes the lifecycle lock only for
   * the recreate, after its pull.
   */
  private readonly updateQueue = new SerialQueue();
  /**
   * Bumped by start(), by stop(), and by an update once it has recreated the
   * container. A retrying `start()` captures the value it began with and
   * stands down once it no longer matches, so a stop or an update retires the
   * loop instead of racing it. An update that fails before its recreate does
   * not bump it, and leaves the loop to bring the container up.
   */
  private lifecycle = 0;
  /** Numbers the start(), stop() and applyUpdate() calls in call order. */
  private calls = 0;
  /** The number of the latest start() or stop() call; 0 before either. */
  private lastStartOrStop = 0;
  /** Between a start() call and the next stop() call. */
  private started = false;
  /**
   * The tag, as requested before resolveTag, that the container is known to
   * run: set once start() or an update brought it up on that tag, unset from
   * the moment one of them may change the container until it succeeds. What
   * {@link ApplyUpdateOptions.ifTag} is compared with.
   */
  private runningAs: string | undefined;
  /**
   * {@link lastStartedTag} as requested, before resolveTag: what the update
   * route re-applies when the client names no tag, so an `onApplied` that
   * saves it keeps a tag like "auto" instead of pinning the version it
   * resolved to.
   */
  private startedAs: string | undefined;

  constructor(options: ManagedContainerOptions) {
    this.options = options;
  }

  /** Queue `fn` behind any lifecycle operation already in flight. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    return this.lifecycleQueue.run(fn);
  }

  /**
   * Rejects update `call` as `cancelled` where the plugin's lifecycle has
   * overtaken it: called while stopped (or before any start), or before the
   * latest start() or stop(). signalk-server mounts plugin routes whether the
   * plugin runs or not, and a restart for a config save must not find the
   * container recreated by an update the old run asked for.
   */
  private throwIfOvertaken(call: number): void {
    if (this.started && this.lastStartOrStop < call) return;
    throw new ContainerHelperError(
      "cancelled",
      this.started
        ? `Update of ${this.options.name} cancelled: the plugin restarted while it ran.`
        : `Update of ${this.options.name} cancelled: the plugin is stopped.`,
      true,
    );
  }

  private get app(): AppLike {
    return this.options.app;
  }

  /**
   * The caller's ensureOptions with `pluginId` defaulted, so signalk-container
   * records this plugin as the container's owner in its manifest. Only an id
   * the manifest accepts is passed: anything else would log a manifest error
   * on every start, so it is left out and the container stays unowned there.
   */
  private get ensureOptions(): EnsureRunningOptions | undefined {
    const { pluginId, ensureOptions } = this.options;
    if (
      ensureOptions?.pluginId !== undefined ||
      !MANIFEST_PLUGIN_ID.test(pluginId)
    ) {
      return ensureOptions;
    }
    return { pluginId, ...ensureOptions };
  }

  private status(msg: string): void {
    if (!this.options.quiet) this.app.setPluginStatus(msg);
  }

  private fail(
    code: ConstructorParameters<typeof ContainerHelperError>[0],
    message: string,
  ): never {
    this.app.setPluginError(message);
    throw new ContainerHelperError(code, message, true);
  }

  private requireManager(): ContainerManagerApi {
    const manager = this.manager ?? getContainerManager();
    if (!manager) {
      this.fail(
        "manager-unavailable",
        "signalk-container plugin not available. Install and enable it, then restart this plugin.",
      );
    }
    this.manager = manager;
    return manager;
  }

  /** Validate a requested tag and apply the resolveTag mapping. */
  private resolveTag(requested: string): string {
    if (!isValidImageTag(requested)) {
      this.fail(
        "invalid-tag",
        `Invalid image tag: ${JSON.stringify(requested)}`,
      );
    }
    const resolved = this.options.resolveTag?.(requested) ?? requested;
    if (!isValidImageTag(resolved)) {
      this.fail(
        "invalid-tag",
        `Invalid resolved image tag: ${JSON.stringify(resolved)}`,
      );
    }
    return resolved;
  }

  /**
   * Match this container in a listContainers() result.
   *
   * `unprefixedName` (supplied by signalk-container since the configurable
   * namespace landed) is the correct, namespace-agnostic key — a container
   * is `<namespace>-<name>`, and the namespace is `sk` only by default
   * (a devcontainer runs `devpod-`, and operators can set any value via
   * SIGNALK_CONTAINER_NAMESPACE). We must NOT hard-code `sk-`, or the helper
   * would fail to find its own container under a non-default namespace.
   *
   * The fallback covers only a signalk-container old enough to predate
   * `unprefixedName`. signalk-container validates the namespace as
   * `[a-z0-9]+` (no hyphen), so the fallback matches `<namespace>-<name>`
   * with a hyphen-free prefix rather than any `-<name>` suffix — otherwise
   * a foreign container like `otherns-app-<name>` would false-match.
   */
  private matchInfo(list: ContainerInfo[]): ContainerInfo | undefined {
    return matchContainerInfo(list, this.options.name);
  }

  /**
   * True when `liveName` is this container under a legacy (pre-
   * `unprefixedName`) signalk-container: either the bare name, or
   * `<namespace>-<name>` where namespace is a single `[a-z0-9]+` token.
   */

  /**
   * Full bring-up: wait for the manager and runtime, validate the tag,
   * self-heal when the live image disagrees with the desired one, reconcile
   * via ensureRunning, register for update detection, then (when configured)
   * resolve the address and wait for the app's HTTP readiness.
   *
   * Emits progress via setPluginStatus but never sets a final "Running"
   * status — that message belongs to the plugin. Throws ContainerHelperError
   * (already reported via setPluginError) on fatal conditions, including
   * `ensure-failed` where signalk-container could not create or start the
   * container; what your own `resolveTag` or `buildConfig` throws passes
   * through as it is. Pair with `startSafely` in a synchronous plugin.start(),
   * which reports both kinds.
   */
  async start(tag?: string, options?: OperationOptions): Promise<StartResult> {
    this.lastStartOrStop = ++this.calls;
    this.started = true;
    const retry = this.options.readinessRetry;
    if (!retry) {
      return this.serialize(() => this.startInner(tag, options?.signal));
    }
    // Compose rather than choose: `readinessRetry.signal` is the instance-wide
    // kill switch and `options.signal` cancels this call, so honouring only
    // one silently ignores whichever the caller did not pass here.
    const signal = anySignal([options?.signal, retry.signal]);
    // A retry loop outlives the call that started it, so a later operation
    // must be able to retire it. Without this, a start() still retrying an old
    // tag keeps calling ensureRunning with that tag after applyUpdate() moved
    // the container to a new one — silently reverting the operator's update.
    const generation = ++this.lifecycle;
    return retryForever(
      () =>
        this.serialize(() => {
          if (generation !== this.lifecycle) {
            throw new ContainerHelperError(
              "cancelled",
              "Superseded by a newer lifecycle operation.",
              true,
            );
          }
          return this.startInner(tag, signal);
        }),
      { ...retry, signal },
    );
  }

  private async startInner(
    tag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<StartResult> {
    const {
      name,
      image,
      buildConfig,
      managerTimeoutMs = 120_000,
      managerPollIntervalMs = 500,
    } = this.options;

    throwIfAborted(signal);
    this.status("Waiting for signalk-container plugin...");
    const { manager, runtime } = await waitForContainerManager({
      timeoutMs: managerTimeoutMs,
      intervalMs: managerPollIntervalMs,
      signal,
      onWaiting: (phase) => {
        if (phase === "runtime")
          this.status("Waiting for container runtime detection...");
      },
    });
    throwIfAborted(signal);
    if (!manager) {
      this.fail(
        "manager-unavailable",
        `signalk-container plugin not available after ${Math.round(managerTimeoutMs / 1000)}s. Install and enable it, then restart this plugin.`,
      );
    }
    if (!runtime) {
      this.fail(
        "no-runtime",
        "No container runtime detected (Podman or Docker). Install one and restart Signal K.",
      );
    }
    this.manager = manager;

    const requested = tag ?? this.options.defaultTag ?? "latest";
    const resolved = this.resolveTag(requested);
    const desiredImage = `${image}:${resolved}`;
    const config = buildConfig(resolved);
    const { ensureOptions } = this;
    // The container may change from here until ensureRunning succeeds.
    this.runningAs = undefined;

    // Startup self-heal: when the plugin bumped its pinned tag, the live
    // container's image disagrees with the desired one. recreate (1.12.0+)
    // applies it immediately instead of trusting drift detection. Compare
    // canonical spellings: podman reports a Docker Hub short name qualified,
    // and a raw compare would recreate such a container on every start.
    let reconciled = false;
    if (typeof manager.recreate === "function") {
      try {
        const found = this.matchInfo(await manager.listContainers());
        throwIfAborted(signal);
        if (
          found &&
          canonicalImageRef(found.image) !== canonicalImageRef(desiredImage)
        ) {
          this.status(`Recreating ${found.image} → ${desiredImage}...`);
          await manager.recreate(name, config, ensureOptions);
          reconciled = true;
        }
      } catch (probeErr) {
        // A cancellation is not a probe failure — it must propagate, or the
        // abandoned start would fall through and ensureRunning anyway.
        if (
          probeErr instanceof ContainerHelperError &&
          probeErr.code === "cancelled"
        ) {
          throw probeErr;
        }
        this.app.debug(
          `self-heal probe failed (non-fatal): ${errMsg(probeErr)}`,
        );
      }
    }

    if (!reconciled) {
      throwIfAborted(signal);
      this.status(`Starting ${desiredImage}...`);
      try {
        await manager.ensureRunning(name, config, ensureOptions);
      } catch (err) {
        throwIfAborted(signal);
        this.fail(
          "ensure-failed",
          `Could not start ${desiredImage}: ${errMsg(err)}`,
        );
      }
    }
    throwIfAborted(signal);
    this.lastStartedTag = resolved;
    this.startedAs = requested;
    this.runningAs = requested;

    this.registerUpdates(manager);

    this.address = null;
    if (this.options.readiness) {
      this.address = await this.awaitReadiness(resolved, signal);
    }

    return { manager, tag: resolved, address: this.address };
  }

  private registerUpdates(manager: ContainerManagerApi): void {
    const updates = this.options.updates;
    if (!updates) return;
    try {
      manager.updates.register({
        pluginId: this.options.pluginId,
        containerName: this.options.name,
        image: this.options.image,
        currentTag:
          updates.currentTag ??
          (() => this.lastStartedTag ?? this.options.defaultTag ?? "latest"),
        currentVersion: updates.currentVersion,
        checkInterval: updates.checkInterval,
        versionSource: buildVersionSource(
          manager.updates,
          updates.versionSource,
        ),
      });
      this.updatesRegistered = true;
    } catch (err) {
      // Non-fatal: the container is up; only update detection is missing.
      this.app.debug(`updates.register failed (non-fatal): ${errMsg(err)}`);
    }
  }

  private async awaitReadiness(
    tag: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const readiness = this.options.readiness!;
    const addr = await this.resolveAddress(readiness.port);
    if (!addr) {
      this.fail(
        "address-unresolved",
        `Could not resolve address for ${this.options.name} port ${readiness.port}. Declare the port in signalkAccessiblePorts.`,
      );
    }
    const base = `http://${addr}`;
    const url = `${base}${readiness.path ?? "/"}`;
    this.status(`Waiting for ${this.options.name} to become ready...`);
    try {
      await waitForHttpReady(url, {
        maxMs: readiness.maxMs,
        intervalMs: readiness.intervalMs,
        requestTimeoutMs: readiness.requestTimeoutMs,
        fetchImpl: this.options.fetchImpl,
        signal,
      });
    } catch (err) {
      // A cancelled readiness wait is not a readiness failure — reporting it
      // as one would put "never became ready" in the plugin error box for a
      // container the caller deliberately abandoned.
      throwIfAborted(signal);
      this.fail(
        "not-ready",
        `${this.options.image}:${tag} started but ${url} never became ready: ${errMsg(err)}`,
      );
    }
    return base;
  }

  /**
   * host:port to reach a container port from the Signal K process.
   * Tries resolveContainerAddress first, then falls back to parsing
   * listContainers() port bindings — the resolver's process-local cache can
   * return a stale port after recreates (seen in production by
   * signalk-backup). Returns null when both fail; never throws.
   */
  async resolveAddress(port: number): Promise<string | null> {
    return resolveContainerEndpoint(
      this.manager ?? getContainerManager(),
      this.options.name,
      port,
      (msg) => this.app.debug(msg),
    );
  }

  /**
   * Teardown for plugin.stop(): unregister from update detection, then stop
   * (NOT remove) the container so re-enabling the plugin restarts it
   * instantly without a pull. Pass the options plugin.stop() received: on a
   * server shutdown the container keeps running (see {@link StopOptions}).
   * Never throws.
   *
   * Cancels every update called before it: one still pulling is not waited
   * for, and stands down once its pull ends, without recreating. One already
   * recreating is waited for, since a recreate cannot be interrupted.
   */
  async stop(options?: StopOptions): Promise<void> {
    // Retires any retry loop still running; see the `lifecycle` field.
    this.lifecycle++;
    this.lastStartOrStop = ++this.calls;
    this.started = false;
    return this.serialize(() => this.stopInner(options?.reason));
  }

  private async stopInner(reason: string | undefined): Promise<void> {
    this.address = null;
    const manager = this.manager ?? getContainerManager();
    if (!manager) return;
    if (this.updatesRegistered) {
      try {
        manager.updates.unregister(this.options.pluginId);
      } catch (err) {
        this.app.debug(`updates.unregister failed: ${errMsg(err)}`);
      }
      this.updatesRegistered = false;
    }
    if (reason === "shutdown") return;
    try {
      await manager.stop(this.options.name);
    } catch (err) {
      this.app.debug(
        `container stop failed (may already be stopped): ${errMsg(err)}`,
      );
    }
  }

  /**
   * Apply a new tag now ("Update now" UX): recreate when available
   * (signalk-container 1.12.0+), otherwise the legacy
   * pull → remove → ensureRunning triplet. The legacy path can strand the
   * plugin between remove and recreate — that failure surfaces as
   * code "recreate-limbo" with a retry-able message.
   *
   * `recreate()` pulls only an image missing from the host: to move a
   * container to a newer image of the same tag, such as `latest`, pass
   * `pull: true` ({@link ApplyUpdateOptions.pull}).
   *
   * Returns the resolved tag. When readiness is configured the address is
   * re-resolved afterwards (non-fatal on failure).
   *
   * Rejects with a `ContainerHelperError` already reported through
   * `setPluginError` (a `cancelled` one is not shown), except for what your
   * own `resolveTag` or `buildConfig` throws, which passes through as it is.
   * Only `recreate-failed` and `recreate-limbo` come after the container may
   * have changed; every other rejection, such as `pull-failed` or
   * `cancelled`, left it as it was.
   *
   * Updates apply in the order they were called. One called while the plugin
   * is stopped (after `stop()`, or before any `start()`), or overtaken by a
   * `start()` or `stop()` before its recreate, rejects as `cancelled`. A
   * `start()` still retrying under `readinessRetry` stands down once the
   * update has recreated the container, not before: an update that fails
   * earlier, as on a pull while offline, leaves it retrying.
   */
  async applyUpdate(
    tag: string,
    options?: ApplyUpdateOptions,
  ): Promise<{ tag: string }> {
    const call = ++this.calls;
    return this.updateQueue.run(() =>
      this.applyUpdateInner(call, tag, options ?? {}),
    );
  }

  private async applyUpdateInner(
    call: number,
    tag: string,
    { signal, pull = false, ifTag }: ApplyUpdateOptions,
  ): Promise<{ tag: string }> {
    throwIfAborted(signal);
    this.throwIfOvertaken(call);
    if (ifTag !== undefined && !isValidImageTag(ifTag)) {
      this.fail("invalid-tag", `Invalid image tag: ${JSON.stringify(ifTag)}`);
    }
    this.throwIfMoved(ifTag);
    const manager = this.requireManager();
    const resolved = this.resolveTag(tag);
    const { image, buildConfig } = this.options;
    const config = buildConfig(resolved);
    const legacy = typeof manager.recreate !== "function";
    // The reference the recreate runs, which buildConfig may spell
    // differently from the options. Before 1.12.0 the update always pulls.
    const ref = legacy
      ? `${image}:${resolved}`
      : `${config.image}:${config.tag}`;

    // Outside the lifecycle lock; see ApplyUpdateOptions.pull.
    let pullError: { err: unknown } | undefined;
    if (legacy || (pull && !config.digest)) {
      this.status(`Pulling ${ref}...`);
      try {
        await manager.pullImage(ref);
      } catch (err) {
        pullError = { err };
      }
    }

    return this.serialize(async () => {
      throwIfAborted(signal);
      this.throwIfOvertaken(call);
      this.throwIfMoved(ifTag);
      if (pullError) {
        // A recreate on the image the container runs would report an update
        // that changed nothing. Read under the lock, so no recreate moves the
        // container meanwhile.
        const other = !legacy && (await this.hostHasOtherImage(manager, ref));
        throwIfAborted(signal);
        this.throwIfOvertaken(call);
        if (!other) {
          this.fail(
            "pull-failed",
            `Could not pull ${ref}, the container was left as it was: ${errMsg(pullError.err)}`,
          );
        }
        this.app.debug(
          `pull of ${ref} failed, recreating on the image the host has: ${errMsg(pullError.err)}`,
        );
      }
      return this.recreateInner(manager, config, tag, resolved);
    });
  }

  /**
   * Rejects an update with `tag-mismatch` where the container is not known to
   * run the tag its caller expected ({@link ApplyUpdateOptions.ifTag}).
   */
  private throwIfMoved(ifTag: string | undefined): void {
    if (ifTag === undefined || this.runningAs === ifTag) return;
    const { name } = this.options;
    throw new ContainerHelperError(
      "tag-mismatch",
      this.runningAs === undefined
        ? `Update of ${name} skipped: it applies only on ${ifTag}, and the tag the container runs is not known, as after a start or update that failed to bring it up.`
        : `Update of ${name} skipped: it applies only on ${ifTag}, but the container runs ${this.runningAs}.`,
      true,
    );
  }

  /** The recreate of an update; runs under the lifecycle lock. */
  private async recreateInner(
    manager: ContainerManagerApi,
    config: ContainerConfig,
    requested: string,
    resolved: string,
  ): Promise<{ tag: string }> {
    const { name, image } = this.options;
    const { ensureOptions } = this;
    // Unknown until the recreate succeeds; a failed one may have removed it.
    this.runningAs = undefined;
    this.status(`Recreating ${name} with ${image}:${resolved}...`);
    if (typeof manager.recreate === "function") {
      // Past this point the container may have changed, so the signal no
      // longer turns a failure into "cancelled": that code means it did not.
      try {
        await manager.recreate(name, config, ensureOptions);
      } catch (err) {
        this.fail(
          "recreate-failed",
          `Recreating ${name} with ${image}:${resolved} failed: ${errMsg(err)}. Apply the update again to retry.`,
        );
      }
    } else {
      try {
        await manager.remove(name);
      } catch (err) {
        this.fail(
          "recreate-failed",
          `Removing ${name} to recreate it with ${image}:${resolved} failed: ${errMsg(err)}. Apply the update again to retry.`,
        );
      }
      try {
        await manager.ensureRunning(name, config, ensureOptions);
      } catch (recreateErr) {
        this.fail(
          "recreate-limbo",
          `Container removed but recreation failed: ${errMsg(recreateErr)}. Apply the update again to retry.`,
        );
      }
    }
    // A start() still retrying the previous tag must not restart the container
    // on the image the operator just moved away from.
    this.lifecycle++;
    this.lastStartedTag = resolved;
    this.startedAs = requested;
    this.runningAs = requested;

    if (this.options.readiness) {
      const addr = await this.resolveAddress(this.options.readiness.port);
      this.address = addr ? `http://${addr}` : this.address;
    }
    this.status(`Updated to ${image}:${resolved}`);
    return { tag: resolved };
  }

  /**
   * Whether the host has an image for `ref` other than the one the container
   * runs, compared by image id, or has one and no container is listed.
   * Names do not tell: podman lists a container under the tag it was
   * created with even after the tag moved to a newer image. False where
   * either id cannot be read; signalk-container reports a listing it cannot
   * read as empty, which reads as no container.
   */
  private async hostHasOtherImage(
    manager: ContainerManagerApi,
    ref: string,
  ): Promise<boolean> {
    try {
      const local = await manager.getImageDigest(ref);
      if (!local) return false;
      const found = this.matchInfo(await manager.listContainers());
      if (!found) return true;
      const running = await manager.getImageDigest(found.name);
      return running !== null && running !== local;
    } catch {
      return false;
    }
  }

  /** updates.checkOne — null when the manager is unavailable. */
  async checkForUpdate(): Promise<UpdateCheckResult | null> {
    const manager = this.manager ?? getContainerManager();
    if (!manager) return null;
    return manager.updates.checkOne(this.options.pluginId);
  }

  /** Container state; 'no-runtime' when the manager is unavailable. Never throws. */
  async getState(): Promise<ContainerState> {
    const manager = this.manager ?? getContainerManager();
    if (!manager) return "no-runtime";
    try {
      return await manager.getState(this.options.name);
    } catch (err) {
      this.app.debug(`getState failed: ${errMsg(err)}`);
      return "no-runtime";
    }
  }

  /**
   * State plus exit status, OOM flag, restart count and healthcheck
   * verdict. Falls back to the coarse state alone when the manager
   * predates `getStateDetail` (signalk-container < 1.31.0), so a caller
   * always gets a usable `state` and simply sees the extra fields
   * undefined. Never throws.
   */
  async getStateDetail(): Promise<ContainerStateDetail> {
    const manager = this.manager ?? getContainerManager();
    if (!manager) return { state: "no-runtime" };
    try {
      if (manager.getStateDetail) {
        return await manager.getStateDetail(this.options.name);
      }
      return { state: await manager.getState(this.options.name) };
    } catch (err) {
      this.app.debug(`getStateDetail failed: ${errMsg(err)}`);
      return { state: "no-runtime" };
    }
  }

  /** State + live image for /status routes. Never throws. */
  async getInfo(): Promise<{
    state: ContainerState | "unknown";
    image: string;
  }> {
    const manager = this.manager ?? getContainerManager();
    let state: ContainerState | "unknown" = "unknown";
    let image = "";
    if (manager) {
      try {
        state = await manager.getState(this.options.name);
      } catch (err) {
        this.app.debug(`status: getState failed: ${errMsg(err)}`);
      }
      if (manager.getRuntime()) {
        try {
          const found = this.matchInfo(await manager.listContainers());
          if (found) image = found.image;
        } catch (err) {
          this.app.debug(`status: listContainers failed: ${errMsg(err)}`);
        }
      }
    }
    return { state, image };
  }

  /** Last N log lines (signalk-container 1.7.0+); null when unsupported. */
  async getLogs(options?: {
    tail?: number;
    since?: number;
  }): Promise<string[] | null> {
    const manager = this.manager ?? getContainerManager();
    if (!manager || typeof manager.getLogs !== "function") return null;
    return manager.getLogs(this.options.name, options);
  }

  /**
   * Mount the standard update endpoints on the plugin router:
   *
   *   GET  <basePath>/check → UpdateCheckResult (503 without a manager)
   *   POST <basePath>/apply → { success: true, tag } — body { tag?: string }
   *
   * Without a `tag` in the body the apply re-applies the tag the container
   * was last started or updated with, as requested (before `resolveTag`), so
   * `onApplied` sees "auto" rather than the version it resolved to.
   *
   * The apply pulls the tag, then recreates the container on it
   * (`applyUpdate()` with {@link ApplyUpdateOptions.pull}). It answers 409,
   * without calling `onApplied`, where the plugin is stopped, or stops or
   * restarts while the update runs: signalk-server keeps the routes of a
   * stopped or disabled plugin mounted.
   *
   * Persist the requested tag from `onApplied` (e.g. via
   * app.savePluginOptions) so the user's choice survives restarts.
   */
  registerUpdateRoutes(
    router: RouterLike,
    options: UpdateRoutesOptions = {},
  ): void {
    const { basePath = "/api/update", onApplied } = options;

    router.get(`${basePath}/check`, async (_req, res) => {
      const manager = this.manager ?? getContainerManager();
      if (!manager) {
        res.status(503).json({ error: "signalk-container not available" });
        return;
      }
      try {
        res.json(await manager.updates.checkOne(this.options.pluginId));
      } catch (err) {
        res.status(500).json({ error: errMsg(err) });
      }
    });

    router.post(`${basePath}/apply`, async (req, res) => {
      const manager = this.manager ?? getContainerManager();
      if (!manager) {
        res.status(503).json({ error: "signalk-container not available" });
        return;
      }
      const body = (req as { body?: { tag?: unknown } }).body;
      const requested =
        typeof body?.tag === "string" && body.tag.length > 0
          ? body.tag
          : (this.startedAs ?? this.options.defaultTag ?? "latest");
      if (!isValidImageTag(requested)) {
        res
          .status(400)
          .json({ error: `Invalid tag: ${JSON.stringify(requested)}` });
        return;
      }
      const startOrStop = this.lastStartOrStop;
      try {
        const { tag } = await this.applyUpdate(requested, { pull: true });
        // A stop or restart during the recreate: onApplied would save the
        // tag over settings the restart may have just saved, so the next
        // start runs the configured tag again.
        if (this.lastStartOrStop !== startOrStop) {
          res.status(409).json({
            error: `The plugin stopped or restarted while the update ran, so ${tag} was not saved.`,
          });
          return;
        }
        await onApplied?.(requested, tag);
        res.json({ success: true, tag });
      } catch (err) {
        const msg = errMsg(err);
        if (err instanceof ContainerHelperError && err.code === "cancelled") {
          res.status(409).json({ error: msg });
          return;
        }
        this.app.setPluginError(`Update failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    });
  }
}
