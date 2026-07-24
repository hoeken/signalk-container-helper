# signalk-container-helper

Helper library for [Signal K](https://signalk.org) plugin developers whose plugins run
containers through the [signalk-container](https://github.com/dirkwa/signalk-container)
plugin.

Every containerized Signal K plugin ends up hand-writing the same integration code:
polling for the container manager, validating tags, calling `ensureRunning`, waiting
for the app inside the container to answer HTTP, registering for update detection,
mounting `/api/update/check` + `apply` routes, and stopping cleanly. This library
packages those patterns — extracted from `signalk-backup`, `mayara-server-signalk-plugin`,
`signalk-doctor`, and `signalk-updater` — into a small, typed, zero-dependency API.

See [SPEC.md](SPEC.md) for the full design rationale.

## Install

```bash
npm install signalk-container-helper
```

Declare the signalk-container relationship in your plugin's `package.json` — do **not**
add signalk-container to `dependencies` or `peerDependencies` (its prerelease
versioning breaks npm semver ranges):

```json
{
  "signalk": {
    "requires": ["signalk-container"]
  }
}
```

Requires **Node ≥ 24**. This library is published as an **ES module** (`import`, not
`require`); consumers must be ESM too.

At **runtime** it works with signalk-container ≥ 1.6.0 — newer manager features
(`recreate`, `getLogs`, …) are feature-detected with graceful fallbacks. Its
**type contract** is validated against **signalk-container ≥ 1.23.2** (1.23.0
first published the `signalk-container/types` entrypoint; 1.23.1 added the
update-service types; 1.23.2 completed their option types); this is a dev-only
check and imposes no dependency on your plugin.

## Quick start: a managed container

For plugins that own their container's lifecycle (the `signalk-backup` /
`mayara` archetype):

```ts
import { ManagedContainer, startSafely } from "signalk-container-helper";

export default function plugin(app) {
  let container: ManagedContainer | null = null;
  let settings = null;

  const plugin = {
    id: "signalk-myservice",
    name: "My Service",

    // Signal K does NOT await start() — keep it synchronous and let
    // startSafely catch and report async failures.
    start(rawConfig) {
      settings = { ...SCHEMA_DEFAULTS, ...rawConfig }; // SK doesn't seed defaults

      container = new ManagedContainer({
        app,
        pluginId: "signalk-myservice",
        name: "myservice", // unprefixed; runtime name is sk-myservice
        image: "ghcr.io/example/myservice",
        defaultTag: "latest",
        buildConfig: (tag) => ({
          image: "ghcr.io/example/myservice",
          tag,
          signalkAccessiblePorts: [9000], // let signalk-container wire networking
          signalkDataMount: "/data", // plugin data dir, deployment-agnostic
          env: { LOG_LEVEL: "info" },
          restart: "unless-stopped",
          resources: {
            cpus: 1,
            memory: "512m",
            memorySwap: "512m",
            pidsLimit: 100,
          },
        }),
        readiness: { port: 9000, path: "/api/health" },
        updates: {
          versionSource: { githubReleases: "example/myservice" },
          currentTag: () => settings?.imageTag ?? "latest",
        },
      });

      startSafely(app, async () => {
        const { address } = await container.start(settings.imageTag);
        // address = "http://127.0.0.1:9000" — the app answered /api/health
        app.setPluginStatus("Running");
      });
    },

    async stop() {
      await container?.stop(); // unregister updates + stop (not remove); never throws
      app.setPluginStatus("Stopped");
    },

    registerWithRouter(router) {
      // GET  /plugins/signalk-myservice/api/update/check
      // POST /plugins/signalk-myservice/api/update/apply   { tag?: string }
      container?.registerUpdateRoutes(router, {
        onApplied: (requestedTag) => {
          // persist the REQUESTED tag (e.g. "auto") so auto-tracking survives
          settings.imageTag = requestedTag;
          app.savePluginOptions(settings, () => undefined);
        },
      });
    },

    schema: () => SCHEMA,
  };
  return plugin;
}
```

What `start()` does for you, in order:

1. **Waits for the manager** — polls `globalThis.__signalk_containerManager`
   (plugins start alphabetically; signalk-container may load after you), then waits
   for runtime detection to settle via `whenReady()`. Distinct, actionable errors for
   "signalk-container missing" vs "no podman/docker found".
2. **Validates the tag** against `/^[a-zA-Z0-9._-]+$/` and applies your
   `resolveTag` mapping (e.g. `"auto"` → a pinned tested version).
3. **Self-heals** — if the live container's image differs from the desired
   `image:tag`, it is `recreate`d immediately (signalk-container ≥ 1.12.0) instead of
   waiting on drift detection.
4. **Reconciles** via `ensureRunning(name, buildConfig(tag))` — declarative and
   idempotent; signalk-container recreates on config drift. No hash files.
5. **Registers for update detection** (non-fatal on failure).
6. **Resolves the address** for your `readiness.port` — with a fallback that parses
   `listContainers()` port bindings, because `resolveContainerAddress` can return a
   stale port after recreates.
7. **Waits for HTTP readiness** — "container running" ≠ "app ready".

Progress is reported through `app.setPluginStatus`; the final "Running" message is
yours to set. Fatal failures throw a typed `ContainerHelperError` _after_ reporting
via `app.setPluginError` — `startSafely` knows not to double-report.

## Quick start: an adopted container

For plugins whose container is managed elsewhere (systemd Quadlet, external host) —
the `signalk-doctor` / `signalk-updater` archetype. Register it for update
notifications and probe its health over HTTP, but never touch its lifecycle:

```ts
import {
  AdoptedContainer,
  probeHttpHealth,
  startSafely,
} from "signalk-container-helper";

const ENGINE_URL = "http://127.0.0.1:3004";

const adopted = new AdoptedContainer({
  app,
  pluginId: "signalk-mytool",
  containerName: "mytool-server",
  image: "ghcr.io/example/mytool-server",
  currentTag: "latest", // what the deployment pins (OperatorIntent)
  currentVersion: async () => {
    // the app's honest version (RuntimeIdentity)
    const res = await fetch(`${ENGINE_URL}/api/health`);
    return ((await res.json()) as { version?: string }).version ?? null;
  },
  versionSource: { githubReleases: "example/mytool-server" }, // LatestAvailable
  checkInterval: "24h",
});

// in start():
startSafely(app, async () => {
  await adopted.register(); // false + setPluginError when unavailable; never throws

  const probe = await probeHttpHealth(`${ENGINE_URL}/api/health`);
  if (!probe.reachable) {
    app.setPluginError(
      "mytool-server is not reachable — is its service running?",
    );
  } else if (probe.slowMs) {
    // Signal K has no warning tier — report slow-but-healthy as a status
    app.setPluginStatus(
      `Reachable but slow (${probe.slowMs}ms) — likely disk I/O contention`,
    );
  } else {
    app.setPluginStatus("Running");
  }
});

// in stop():
adopted.unregister();
```

Why not `manager.getState()` for health? signalk-container namespace-prefixes the
containers it manages (`sk-<name>`); externally-managed peers don't carry the prefix,
so the manager can't see them — and "running" isn't "healthy" anyway.

## API overview

| Export                          | Purpose                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ManagedContainer`              | Full lifecycle: `start`, `stop`, `applyUpdate`, `checkForUpdate`, `getState`, `getInfo`, `resolveAddress`, `getLogs`, `registerUpdateRoutes`                                                                                                                                             |
| `AdoptedContainer`              | Update registration + checks for externally-managed containers                                                                                                                                                                                                                           |
| `getContainerManager()`         | Read the `globalThis.__signalk_containerManager` global                                                                                                                                                                                                                                  |
| `waitForContainerManager(opts)` | Two-phase wait (manager present → runtime settled); returns `{ manager, runtime }` so the two failure modes get distinct messages                                                                                                                                                        |
| `waitForHttpReady(url, opts)`   | Poll until 2xx or deadline (throws)                                                                                                                                                                                                                                                      |
| `probeHttpHealth(url, opts)`    | Retrying liveness probe with slow-response detection (never throws)                                                                                                                                                                                                                      |
| `fetchWithTimeout(url, opts)`   | `fetch` with an `AbortController` timeout                                                                                                                                                                                                                                                |
| `startSafely(app, fn)`          | Sync wrapper for async plugin startup — Signal K does not await `start()`                                                                                                                                                                                                                |
| `isValidImageTag(tag)`          | Tag guard (`IMAGE_TAG_PATTERN`)                                                                                                                                                                                                                                                          |
| `errMsg(err)`                   | Normalize unknown errors to strings                                                                                                                                                                                                                                                      |
| `ContainerHelperError`          | Typed error with `code` and `reported`                                                                                                                                                                                                                                                   |
| Types                           | Local mirror of signalk-container's public API — `ContainerManagerApi`, `ContainerConfig`, `EnsureRunningOptions`, `UpdateServiceApi`, … — verified at build time against `signalk-container/types` (≥ 1.23.2) so it never silently drifts. Feature-detected members stay optional here. |

### Error codes

`ContainerHelperError.code` values thrown by `start()` / `applyUpdate()`:

| Code                  | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `manager-unavailable` | signalk-container never published its API within the budget                    |
| `no-runtime`          | Manager present, but no podman/docker was detected                             |
| `invalid-tag`         | Tag failed the `IMAGE_TAG_PATTERN` guard                                       |
| `address-unresolved`  | No host:port could be found for the readiness port                             |
| `not-ready`           | The app never answered its health URL before the deadline                      |
| `recreate-limbo`      | Legacy update path removed the container but recreation failed — retry applies |

All errors thrown by the helpers have already been surfaced through
`app.setPluginError` (`reported: true`), so `startSafely` won't report them twice.

### Version compatibility

The helpers feature-detect newer signalk-container capabilities:

| Capability                    | Floor  | Fallback behavior                                            |
| ----------------------------- | ------ | ------------------------------------------------------------ |
| `whenReady()`                 | 1.6.0  | polls `getRuntime()`                                         |
| `getLogs()`                   | 1.7.0  | `getLogs()` returns `null`                                   |
| `recreate()`                  | 1.12.0 | self-heal skipped; updates use pull → remove → ensureRunning |
| `ContainerConfig.healthcheck` | 1.14.0 | ignored by older versions                                    |
| `ContainerConfig.ulimits`     | 1.17.0 | ignored by older versions                                    |

## Design rules inherited from the reference plugins

- **Runtime-only coupling.** Never import signalk-container; reach it through the
  global. The types shipped here are a mirror, not a dependency.
- **Never throw out of `start()`.** The server doesn't await it — use `startSafely`.
- **Stop, don't remove.** `stop()` leaves the container in place so re-enabling the
  plugin restarts it instantly without a pull.
- **Offline is normal.** Boats at sea lose connectivity; nothing here converts a
  network failure into a fatal error.
- **The user owns updates.** Update detection notifies; applying is an explicit
  action (`applyUpdate` / the POST route). Persist the _requested_ tag (e.g.
  `"auto"`), not the resolved version, so auto-tracking survives restarts.

## Development

```bash
npm install
npm test          # typecheck the type contract, then vitest (fully mocked — no containers needed)
npm run build     # tsc → dist/
npm run format    # prettier --write + eslint --fix
npm run ci-lint   # eslint + prettier --check (what CI runs)
```

CI (`.github/workflows/ci.yml`) runs `ci-lint`, `build`, and `test` on every push and pull request.

## Releasing

This library is distributed through **npm with semver** — consumers `npm install signalk-container-helper` and pin a range (`^1.0.0`); they never build against `master`. `master` is the development trunk and may be mid-change without affecting anyone.

Releases are tag-triggered (`.github/workflows/publish.yml` fires on `v*` tags):

1. Bump `version` in `package.json`, commit, and merge to `master`.
2. Tag `vX.Y.Z` and push the tag.
3. The workflow builds, tests, creates a GitHub Release (auto-generated notes), and runs `npm publish --provenance` (prereleases `-beta.`/`-rc.` publish under the `beta` dist-tag).

Publishing requires an `NPM_TOKEN` repository secret with publish rights to the package.

## License

Apache-2.0
