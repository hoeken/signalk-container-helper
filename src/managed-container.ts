import type {
  AppLike,
  ContainerConfig,
  ContainerInfo,
  ContainerManagerApi,
  ContainerState,
  EnsureRunningOptions,
  UpdateCheckResult,
} from "./types.js";
import { getContainerManager, waitForContainerManager } from "./manager.js";
import {
  buildVersionSource,
  type VersionSourceSpec,
} from "./version-source.js";
import { waitForHttpReady, type FetchLike } from "./http.js";
import { ContainerHelperError, errMsg, isValidImageTag } from "./util.js";

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
  /** Register with signalk-container's update-detection service (optional). */
  updates?: ManagedUpdateOptions;
  /** Passed through to ensureRunning/recreate (onVolumeIssue, logs, …). */
  ensureOptions?: EnsureRunningOptions;
  /** Suppress setPluginStatus progress lines. Default false. */
  quiet?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
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
   */
  onApplied?: (
    requestedTag: string,
    resolvedTag: string,
  ) => void | Promise<void>;
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

  constructor(options: ManagedContainerOptions) {
    this.options = options;
  }

  private get app(): AppLike {
    return this.options.app;
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
    const { name } = this.options;
    // Two passes so the reliable key wins regardless of list order: an
    // exact unprefixedName match anywhere beats a legacy prefix match.
    return (
      list.find((c) => c.unprefixedName === name) ??
      list.find(
        (c) => c.unprefixedName === undefined && this.matchesLegacyName(c.name),
      )
    );
  }

  /**
   * True when `liveName` is this container under a legacy (pre-
   * `unprefixedName`) signalk-container: either the bare name, or
   * `<namespace>-<name>` where namespace is a single `[a-z0-9]+` token.
   */
  private matchesLegacyName(liveName: string): boolean {
    const { name } = this.options;
    if (liveName === name) return true;
    const suffix = `-${name}`;
    if (!liveName.endsWith(suffix)) return false;
    const prefix = liveName.slice(0, -suffix.length);
    return /^[a-z0-9]+$/.test(prefix);
  }

  /**
   * Full bring-up: wait for the manager and runtime, validate the tag,
   * self-heal when the live image disagrees with the desired one, reconcile
   * via ensureRunning, register for update detection, then (when configured)
   * resolve the address and wait for the app's HTTP readiness.
   *
   * Emits progress via setPluginStatus but never sets a final "Running"
   * status — that message belongs to the plugin. Throws ContainerHelperError
   * (already reported via setPluginError) on fatal conditions; pair with
   * `startSafely` in a synchronous plugin.start().
   */
  async start(tag?: string): Promise<StartResult> {
    const {
      name,
      image,
      buildConfig,
      ensureOptions,
      managerTimeoutMs = 120_000,
      managerPollIntervalMs = 500,
    } = this.options;

    this.status("Waiting for signalk-container plugin...");
    const { manager, runtime } = await waitForContainerManager({
      timeoutMs: managerTimeoutMs,
      intervalMs: managerPollIntervalMs,
      onWaiting: (phase) => {
        if (phase === "runtime")
          this.status("Waiting for container runtime detection...");
      },
    });
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

    const resolved = this.resolveTag(
      tag ?? this.options.defaultTag ?? "latest",
    );
    const desiredImage = `${image}:${resolved}`;
    const config = buildConfig(resolved);

    // Startup self-heal: when the plugin bumped its pinned tag, the live
    // container's image disagrees with the desired one. recreate (1.12.0+)
    // applies it immediately instead of trusting drift detection.
    let reconciled = false;
    if (typeof manager.recreate === "function") {
      try {
        const found = this.matchInfo(await manager.listContainers());
        if (found && found.image !== desiredImage) {
          this.status(`Recreating ${found.image} → ${desiredImage}...`);
          await manager.recreate(name, config, ensureOptions);
          reconciled = true;
        }
      } catch (probeErr) {
        this.app.debug(
          `self-heal probe failed (non-fatal): ${errMsg(probeErr)}`,
        );
      }
    }

    if (!reconciled) {
      this.status(`Starting ${desiredImage}...`);
      await manager.ensureRunning(name, config, ensureOptions);
    }
    this.lastStartedTag = resolved;

    this.registerUpdates(manager);

    this.address = null;
    if (this.options.readiness) {
      this.address = await this.awaitReadiness(resolved);
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

  private async awaitReadiness(tag: string): Promise<string> {
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
      });
    } catch (err) {
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
    const manager = this.manager ?? getContainerManager();
    if (!manager) return null;
    try {
      const answer = await manager.resolveContainerAddress(
        this.options.name,
        port,
      );
      if (answer) return answer;
    } catch (err) {
      this.app.debug(`resolveContainerAddress failed: ${errMsg(err)}`);
    }
    try {
      const found = this.matchInfo(await manager.listContainers());
      const wanted = `->${port}/tcp`;
      for (const entry of found?.ports ?? []) {
        if (!entry.endsWith(wanted)) continue;
        const hostPart = entry.slice(0, -wanted.length);
        if (hostPart.includes(":")) return hostPart;
      }
    } catch (err) {
      this.app.debug(`listContainers port fallback failed: ${errMsg(err)}`);
    }
    return null;
  }

  /**
   * Teardown for plugin.stop(): unregister from update detection, then stop
   * (NOT remove) the container so re-enabling the plugin restarts it
   * instantly without a pull. Never throws.
   */
  async stop(): Promise<void> {
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
   * Returns the resolved tag. When readiness is configured the address is
   * re-resolved afterwards (non-fatal on failure).
   */
  async applyUpdate(tag: string): Promise<{ tag: string }> {
    const manager = this.requireManager();
    const resolved = this.resolveTag(tag);
    const { name, image, buildConfig, ensureOptions } = this.options;
    const config = buildConfig(resolved);

    this.status(`Recreating ${name} with ${image}:${resolved}...`);
    if (typeof manager.recreate === "function") {
      await manager.recreate(name, config, ensureOptions);
    } else {
      await manager.pullImage(`${image}:${resolved}`);
      await manager.remove(name);
      try {
        await manager.ensureRunning(name, config, ensureOptions);
      } catch (recreateErr) {
        this.fail(
          "recreate-limbo",
          `Container removed but recreation failed: ${errMsg(recreateErr)}. Apply the update again to retry.`,
        );
      }
    }
    this.lastStartedTag = resolved;

    if (this.options.readiness) {
      const addr = await this.resolveAddress(this.options.readiness.port);
      this.address = addr ? `http://${addr}` : this.address;
    }
    this.status(`Updated to ${image}:${resolved}`);
    return { tag: resolved };
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
          : (this.lastStartedTag ?? this.options.defaultTag ?? "latest");
      if (!isValidImageTag(requested)) {
        res
          .status(400)
          .json({ error: `Invalid tag: ${JSON.stringify(requested)}` });
        return;
      }
      try {
        const { tag } = await this.applyUpdate(requested);
        await onApplied?.(requested, tag);
        res.json({ success: true, tag });
      } catch (err) {
        const msg = errMsg(err);
        this.app.setPluginError(`Update failed: ${msg}`);
        res.status(500).json({ error: msg });
      }
    });
  }
}
