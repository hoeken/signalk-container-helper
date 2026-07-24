# signalk-container-helper — Specification

An abstraction library (npm module) for Signal K plugin developers whose plugins run
containers through the [signalk-container](https://github.com/dirkwa/signalk-container)
plugin. It packages the container-integration patterns that every consumer plugin
currently hand-copies — discovery, startup, readiness, updates, teardown — into a small,
typed, zero-dependency API.

## 1. Background: what the reference plugins actually do

Four plugins were analyzed: `mayara-server-signalk-plugin`, `signalk-backup`,
`signalk-doctor`, `signalk-updater`, plus the signalk-container source itself (v1.22.0).

They fall into **two archetypes**:

|                     | Managed (backup, mayara)                                  | Adopt-only (doctor, updater)                             |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Container lifecycle | Owned by the plugin via `ensureRunning`/`recreate`/`stop` | Owned externally (systemd Quadlet); plugin never mutates |
| Update service      | `register` + `checkOne` + apply route                     | `register`/`unregister` only                             |
| Health              | HTTP-poll the containerized app                           | HTTP-probe with retry + slow detection                   |
| Manager wait budget | 30–120 s                                                  | 30 s                                                     |

Every plugin independently re-implements the same building blocks (all four have
near-identical copies):

1. **Manager discovery** — poll `globalThis.__signalk_containerManager` every 500 ms
   until it exists AND `getRuntime()` is non-null (plugins load alphabetically, and
   runtime probing is async). mayara adds a second phase using `whenReady()` (1.6.0+).
2. **Hand-rolled type mirror** — each plugin maintains its own `src/types.ts` copy of
   signalk-container's API (synced against different versions: 1.6.0, 1.10.2), because
   importing signalk-container at compile time is forbidden (runtime-only coupling) and
   npm `peerDependencies` break against its prereleases.
3. **`buildContainerConfig(tag)`** — a function producing a declarative `ContainerConfig`
   (split `image` + `tag`, resources defaults, restart `unless-stopped`), passed to
   `ensureRunning` on every start; drift detection recreates as needed.
4. **Tag validation** — `SAFE_TAG = /^[a-zA-Z0-9._-]+$/` before anything reaches the
   runtime, plus optional `'auto'` → pinned-version resolution (backup).
5. **Self-heal on startup** — compare the live container's image against the desired
   `image:tag` via `listContainers()` (matching `sk-<name>`), and `recreate` when they
   differ. Feature-detected (`recreate` is 1.12.0+).
6. **Update apply** — `recreate(name, config)` with a legacy fallback of
   `pullImage` → `remove` → `ensureRunning`, including the "removed but recreation
   failed" limbo error message. Requested tag persisted via `savePluginOptions`
   (persisting `'auto'`, not the resolved version).
7. **Update registration** — `updates.register({pluginId, containerName, image,
currentTag: () => …, versionSource: sources.githubReleases(repo), currentVersion?,
checkInterval?})` at start; `unregister` at stop; both wrapped non-fatally.
8. **Address resolution** — `resolveContainerAddress(name, port)` with a documented
   production bug workaround: fall back to parsing `listContainers()[].ports` for a
   `"host:port->port/tcp"` entry, because the resolver can return a stale port.
9. **HTTP readiness** — poll the containerized app's own `/api/health` (deadline +
   interval + per-request `AbortController` timeout). "Container running" ≠ "app ready".
10. **HTTP health probe** — N attempts, per-attempt timeout, inter-attempt delay, and a
    "reachable but slow" threshold (no SignalK warning tier, so slow → green status text).
11. **Teardown** — `updates.unregister` then `containers.stop` (stop, never remove — the
    container restarts instantly on re-enable), everything swallowed.
12. **Never throw out of `start()`** — sync `start()` + `asyncStart().catch(err =>
setPluginError(...))`, because the server does not await plugin `start()`.
13. **Schema defaults merge** — `{...SCHEMA_DEFAULTS, ...rawConfig}` because Signal K
    does not seed schema defaults at runtime.

## 2. Goals

- One import that provides the **managed-container lifecycle** end-to-end:
  wait-for-manager → validate tag → self-heal → `ensureRunning` → register updates →
  resolve address → wait-for-ready.
- First-class support for the **adopt-only** archetype (update registration + HTTP
  health probing without lifecycle mutation).
- Ship the **canonical TypeScript mirror** of signalk-container's public API so plugins
  stop hand-maintaining divergent copies. Runtime coupling stays via `globalThis` —
  the library never imports signalk-container.
- **Feature-detect** optional/newer manager methods (`recreate`, `resolveHostPath`,
  `getLogs`, …) and provide legacy fallbacks, with version floors documented.
- **Marine-grade error handling**: helpers never throw for expected conditions without
  an actionable message; non-fatal operations are swallowed with `app.debug`; offline
  is a normal state.
- Zero runtime dependencies. ESM output + `.d.ts`. Node ≥ 24.

## 3. Non-goals

- Talking to Docker/Podman directly — everything goes through signalk-container.
- Owning the plugin's config schema, webapp, or final status message.
- Applying updates automatically (detection-only service stays user-confirmed;
  `autoUpdateOnFloatingTag` remains a per-config opt-in the caller sets).
- Wrapping `runJob`/one-shot jobs beyond re-exporting the types (no consumer among the
  four uses them; can be added later).

## 4. Public API

```ts
import {
  // discovery
  getContainerManager,
  waitForContainerManager,
  // archetypes
  ManagedContainer,
  AdoptedContainer,
  // http utilities
  fetchWithTimeout,
  waitForHttpReady,
  probeHttpHealth,
  // misc utilities
  startSafely,
  errMsg,
  isValidImageTag,
  IMAGE_TAG_PATTERN,
  ContainerHelperError,
  // full type mirror
  type ContainerManagerApi,
  type ContainerConfig /* … */,
} from "signalk-container-helper";
```

### 4.1 Discovery

```ts
getContainerManager(): ContainerManagerApi | undefined

waitForContainerManager(options?: {
  timeoutMs?: number       // default 60_000
  intervalMs?: number      // default 500
  onWaiting?: (phase: 'manager' | 'runtime') => void
}): Promise<{ manager: ContainerManagerApi | undefined; runtime: ContainerRuntimeInfo | null }>
```

Two-phase wait: poll the global until present, then `whenReady()` (feature-detected,
falling back to polling `getRuntime()`), then re-check `getRuntime()`. The result
distinguishes the two failure modes every plugin reports differently:
`manager === undefined` → "signalk-container is not installed/enabled";
`manager && !runtime` → "no container runtime detected (podman/docker missing)".

### 4.2 `ManagedContainer` (backup/mayara archetype)

```ts
const container = new ManagedContainer({
  app,                                  // setPluginStatus/setPluginError/debug
  pluginId: 'signalk-questdb',
  name: 'questdb',                      // unprefixed container name
  image: 'ghcr.io/questdb/questdb',     // registry path, no tag
  buildConfig: (tag) => ({ image: 'ghcr.io/questdb/questdb', tag, /* … */ }),
  defaultTag: 'latest',
  resolveTag: (t) => t === 'auto' ? PINNED_VERSION : t,   // optional
  managerTimeoutMs: 120_000,
  readiness: { port: 9000, path: '/ping', maxMs: 60_000 },   // optional
  updates: {                                                  // optional
    versionSource: { githubReleases: 'questdb/questdb' },
    currentTag: () => currentSettings?.version ?? 'auto',
  },
  ensureOptions: { onVolumeIssue, onContainerLog },           // passed through
})

await container.start(tag?)        // full bring-up; returns { manager, tag, address }
await container.stop()             // unregister + stop (not remove); never throws
await container.applyUpdate(tag)   // recreate, or legacy pull+remove+ensureRunning
await container.checkForUpdate()   // updates.checkOne → UpdateCheckResult | null
await container.getState()         // ContainerState ('unknown-manager' safe default)
await container.getInfo()          // { state, image } for /status routes
await container.resolveAddress(p)  // resolveContainerAddress + stale-port fallback
await container.getLogs(opts?)     // feature-detected passthrough
container.registerUpdateRoutes(router, { onApplied })  // GET check / POST apply
```

`start()` sequencing (each step from the reference plugins):

1. `waitForContainerManager` — on failure sets an actionable `setPluginError` and throws
   `ContainerHelperError` with `code: 'manager-unavailable' | 'no-runtime'` and
   `reported: true` (so `startSafely` doesn't double-report).
2. Validate requested tag (`IMAGE_TAG_PATTERN`), apply `resolveTag`.
3. Self-heal: when `manager.recreate` exists, compare the live container's image
   (matched by `unprefixedName`, falling back to `sk-<name>`) to `image:tag`; `recreate`
   on mismatch. Probe failures are non-fatal (debug + fall through).
4. Otherwise `ensureRunning(name, buildConfig(tag), ensureOptions)`.
5. Register with the update service (non-fatal; `currentTag` defaults to a live getter
   of the last started tag).
6. If `readiness` is configured: resolve the address (throws `'address-unresolved'`
   if impossible) and poll `http://<addr><path>` until ready (throws `'not-ready'` on
   deadline).

The helper emits progress via `setPluginStatus` ("Waiting for…", "Starting…",
"Recreating…") but **never sets the final "Running" status** — the plugin owns that.

### 4.3 `AdoptedContainer` (doctor/updater archetype)

```ts
const adopted = new AdoptedContainer({
  app,
  pluginId: "signalk-doctor",
  containerName: "signalk-doctor-server",
  image: "ghcr.io/dirkwa/signalk-doctor-server",
  currentTag: "latest", // string or () => string
  currentVersion: () => fetchEngineVersion(), // optional, preferred by comparator
  versionSource: { githubReleases: "dirkwa/signalk-doctor-server" },
  checkInterval: "24h",
  managerTimeoutMs: 30_000,
});

await adopted.register(); // waits for manager; false + setPluginError if unavailable
adopted.unregister(); // best-effort, never throws
await adopted.checkForUpdate();
```

No lifecycle mutation, matching the "adopt, don't manage" rule.

### 4.4 HTTP utilities

```ts
fetchWithTimeout(url, { timeoutMs = 10_000, fetchImpl = fetch, ...init });
waitForHttpReady(url, {
  maxMs = 60_000,
  intervalMs = 1_000,
  requestTimeoutMs = 2_000,
});
probeHttpHealth(url, {
  attempts = 3,
  attemptTimeoutMs = 5_000,
  retryDelayMs = 2_000,
  slowMs = 1_500,
});
// → { reachable: boolean, slowMs?: number } — never throws
```

Defaults are the constants shared across the four plugins. `fetchImpl` is injectable
for tests.

### 4.5 Misc

```ts
startSafely(app, () => asyncStart(config));
// sync wrapper for plugin.start(): catches, reports via setPluginError unless the
// error is a ContainerHelperError already reported by the helper

errMsg(err); // unknown → string
isValidImageTag(tag); // SAFE_TAG check
class ContainerHelperError extends Error {
  code:
    | "manager-unavailable"
    | "no-runtime"
    | "invalid-tag"
    | "address-unresolved"
    | "not-ready"
    | "recreate-limbo";
  reported: boolean; // true when the helper already called setPluginError
}
```

### 4.6 Types module

A documented mirror of signalk-container's public surface, synced against **v1.22.0**:
`ContainerManagerApi`, `ContainerConfig` (incl. `signalkDataMount`,
`signalkConfigRootMount`, `signalkAccessiblePorts`, `healthcheck`, `ulimits`, `labels`,
`digest`, `updateChannel`, `autoUpdateOnFloatingTag`, `user`, `extraHosts`),
`EnsureRunningOptions`, `VolumeSpec`/`VolumeIssue`, `ContainerResourceLimits`,
`ContainerInfo`, `ContainerJobConfig`/`Result`, `UpdateServiceApi` and friends, and the
`globalThis` declaration. Methods newer than the **1.6.0 baseline** are optional in the
type, forcing feature-detection at call sites:

| Optional member                         | Version floor                               |
| --------------------------------------- | ------------------------------------------- |
| `getLogs`                               | 1.7.0                                       |
| `resolveHostPath`                       | 1.7.0 (partial earlier)                     |
| `doctor.*`                              | 1.8.0–1.10.0                                |
| `recreate`                              | 1.12.0                                      |
| `execInContainer`, network methods      | varies                                      |
| `removeManagedData`                     | 1.18.0                                      |
| `manifest.*`                            | 1.13.0+                                     |
| Config fields `healthcheck` / `ulimits` | 1.14.0 / 1.17.0 (ignored by older versions) |

## 5. Error-handling philosophy

- `stop()`, `unregister()`, `getInfo()`, `checkForUpdate()` never throw — degraded
  results (`null`, `'unknown'`) plus `app.debug`.
- `start()` / `applyUpdate()` throw typed `ContainerHelperError`s with actionable
  messages; the helper sets `setPluginError` first and marks the error `reported`.
- The legacy update path preserves the "Container removed but recreation failed —
  retry" limbo message (`code: 'recreate-limbo'`).
- Offline is normal: nothing in the helper converts a network failure into a fatal.

## 6. Packaging & compatibility

- npm module `signalk-container-helper`, Apache-2.0, zero runtime dependencies.
- TypeScript → **ESM** (`dist/`) + declarations; `engines.node >= 24`. The package is
  `"type": "module"`; relative imports carry `.js` extensions (NodeNext resolution).
- Consumers must NOT add signalk-container to `dependencies`/`peerDependencies`
  (its prereleases break npm semver ranges); declare it via `"signalk": { "requires":
["signalk-container"] }` in package.json. The README documents this.
- Supported signalk-container **runtime** baseline: **≥ 1.6.0** (for `whenReady`);
  newer features degrade gracefully via feature detection.
- The library's own type mirror is validated at build time against
  **signalk-container ≥ 1.23.2** (the `signalk-container/types` entrypoint, whose
  update-service types and their options 1.23.1–1.23.2 completed) via a `tsc`-checked contract test
  (`test/types-contract.test-d.ts`), so drift from the canonical public API fails
  CI. This is a dev-only devDependency; it imposes nothing on consumers.

## 7. Test plan

Unit tests (vitest) against a fake manager installed on `globalThis` and an injected
`fetchImpl` — no real containers or network:

- discovery: late-appearing manager, `whenReady` path, legacy polling path, runtime
  failure vs manager absence, timeout.
- `ManagedContainer.start`: ensureRunning call shape, self-heal recreate on image
  drift, non-fatal probe failure, update registration, address resolution incl.
  stale-port fallback parse, readiness polling, tag validation, error codes.
- `applyUpdate`: recreate path, legacy triplet fallback, limbo error.
- `stop`: unregister + stop ordering, error swallowing.
- update routes: 503 without manager, check passthrough, apply happy path/400/500.
- `AdoptedContainer`: register/unregister, manager-missing reporting.
- http: `probeHttpHealth` retry/slow/exhaustion; `waitForHttpReady` deadline.
- utils: tag pattern, `errMsg`, `startSafely` double-report suppression.
