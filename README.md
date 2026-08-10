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

It also ships the shared **React config-panel building blocks** those plugins
hand-copied (container status card, image-version dropdown, update controls) as
a separate browser-side entrypoint, [`signalk-container-helper/ui`](#config-panel-ui-signalk-container-helperui).

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

Requires **Node ≥ 22**. This library is published as an **ES module** (`import`, not
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
  // false + setPluginError when unavailable; never throws. Stop here so we
  // don't overwrite that error with a health status below.
  if (!(await adopted.register())) return;

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

## Config-panel UI (`signalk-container-helper/ui`)

The reference plugins also share a hand-copied React config panel: a container
status card, an image-version dropdown, a check/apply update row, and the same
inline-style vocabulary. The `/ui` entrypoint packages those as reusable
components and hooks. It is a separate subpath export — the main entry stays
Node-only and zero-dependency; `/ui` needs `react` (an optional peer
dependency) and runs in the Signal K Admin UI page.

### How it fits the standard panel build

Signal K loads plugin config panels as **webpack Module Federation remotes**
(`public/remoteEntry.js` exposing `./PluginConfigurationPanel`, with `react`
shared as a singleton). The standard webpack config runs `babel-loader` with
`exclude: /node_modules/`, so a library shipping raw JSX would break the
build. This entrypoint therefore ships **tsc-compiled `React.createElement`
JS (no JSX)** that webpack bundles directly, and its `import "react"` resolves
to the host Admin UI's shared React singleton. No loader changes are needed —
but the remote's output format must match your package's module type (next
section).

```bash
npm install signalk-container-helper react
```

(`react` can be a devDependency of your plugin — it is only used at bundle
time; at runtime the Admin UI provides the singleton.)

### ESM plugins must build an ESM remote

The server injects each panel's script tag based on the **plugin's**
package.json `type` field:

```js
moduleInfo.type === "module"
  ? `<script type="module" src="/${moduleInfo.name}/remoteEntry.js"></script>`
  : `<script src="/${moduleInfo.name}/remoteEntry.js"></script>`;
```

The remote's output format must match, and the failure modes on a mismatch
are unhelpful, so get this right up front:

- **CommonJS plugin** (the reference plugins): the classic remote —
  `library: { type: "var", name: "<name with [-@/] → _>" }` — which lands on
  `window` when the plain script tag runs.
- **`"type": "module"` plugin** (likely yours — this library is ESM-only):
  the Admin UI loads the panel with a dynamic `import()` and requires real
  `get`/`init` module exports. A copied `var` remote loads silently into
  module scope — no window global, no exports — and the panel dies with
  _'Module "…" is not available. Make sure the webapp is installed.'_ even
  though discovery and serving worked. Build an **ESM container** instead:

  ```js
  // webpack.config.cjs (an ESM package needs the .cjs extension, or an ESM config)
  module.exports = {
    // ...
    experiments: { outputModule: true },
    output: {
      path: path.resolve(__dirname, "public"),
      module: true,
      clean: false,
    },
    plugins: [
      new ModuleFederationPlugin({
        name: "your_plugin_name",
        library: { type: "module" }, // no global var name
        filename: "remoteEntry.js",
        exposes: {
          "./PluginConfigurationPanel":
            "./src/configpanel/PluginConfigurationPanel",
        },
        shared: {
          react: { singleton: true, requiredVersion: "^19" },
          "react-dom": { singleton: true, requiredVersion: "^19" },
        },
      }),
    ],
  };
  ```

  Chunks emit as `.mjs`; verify the container shape with
  `node -e 'import("./public/remoteEntry.js").then((m) => console.log(typeof m.get, typeof m.init))'`
  (both must print `function`).

The mismatch breaks in the other direction too: a CJS package emitting an ESM
remote throws a `SyntaxError` when the browser executes `export` syntax from
a plain script tag. A working ESM example is
[signalk-piper](https://github.com/hoeken/signalk-piper)'s
`webpack.config.cjs`.

### Example panel

```jsx
import React, { useState } from "react";
import {
  panelStyles as S,
  SectionTitle,
  StatusCard,
  FieldRow,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";

const BASE = "/plugins/signalk-myservice";

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};
  const [tag, setTag] = useState(cfg.imageTag || "latest");
  const [saved, setSaved] = useState("");

  // Polls /api/status every 5s; parses non-2xx bodies too (unhealthy
  // responses often carry fields the panel must surface).
  const { status, loading } = useStatusPoll(`${BASE}/api/status`, {
    fallback: { status: "not_running" },
  });

  // Fetches /api/versions once; refresh() from the ↻ button. Accepts a bare
  // VersionInfo[] or the structured { versions, sources } shape, and keeps
  // the last known list when the fetch fails.
  const versions = useVersions(`${BASE}/api/versions`);

  const running = status?.status === "running";
  return (
    <div style={S.root}>
      <SectionTitle>My Service Status</SectionTitle>
      <StatusCard
        icon="M"
        iconBackground={running ? "#7c3aed" : undefined}
        title="My Service"
        meta={
          loading ? "Checking..." : running ? status.endpoint : "Not running"
        }
        state={running ? "ok" : "error"}
        link={running ? { href: status.url, label: "Open ↗" } : undefined}
      />

      {/* Talks to the routes ManagedContainer.registerUpdateRoutes mounts. */}
      {running && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={tag}
        />
      )}

      <SectionTitle>Settings</SectionTitle>
      <FieldRow label="Image version">
        <VersionSelect
          value={tag}
          onChange={setTag}
          versions={versions.versions}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={versions.refresh}
        />
      </FieldRow>

      <CollapsibleSection title="Advanced">
        <FieldRow label="Extra arguments" hint="rarely needed">
          <input style={S.input} />
        </FieldRow>
      </CollapsibleSection>

      <ActionStatus message={saved} />
      <div style={{ marginTop: 24 }}>
        <Button
          onClick={() => {
            save({ ...cfg, imageTag: tag });
            setSaved("Saved! Plugin will restart with new configuration.");
          }}
        >
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
```

### UI exports

| Export                                                                             | Purpose                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panelStyles`, `stateColors`                                                       | The shared inline-style vocabulary (`root`, `card`, `fieldRow`, `input`, `warnBanner`, …). Inline styles are deliberate: a CSS file shipped by a federation remote would leak into or be clobbered by the host page. Spread-extend: `{ ...panelStyles.input, width: 300 }` |
| `StatusCard`, `StateDot`                                                           | Container status card (icon, title, meta, optional link, state dot) and the bare green/amber/red dot                                                                                                                                                                       |
| `VersionSelect`                                                                    | Image-version dropdown: floating tags (`latest`, `main`, …), pre-releases, stable releases, PR test images — and a synthetic `<tag> (running)` option when the current value isn't listed, so the controlled select never silently resets the running image                |
| `UpdateControls`                                                                   | Self-contained check/apply row against `registerUpdateRoutes`' contract (`GET check` → `UpdateCheckResult`, `POST apply` → `{ success, tag }`)                                                                                                                             |
| `SectionTitle`, `FieldRow`, `Hint`, `CollapsibleSection`, `Button`, `ActionStatus` | Form scaffolding: uppercase section headings, label + control + hint rows, collapsed-by-default advanced sections (keyboard-accessible), busy-aware buttons, the green/red outcome line                                                                                    |
| `useStatusPoll(url, opts)`                                                         | Self-scheduling status poll (no overlapping requests on slow hosts; stale responses dropped; body parsed on non-2xx too)                                                                                                                                                   |
| `useVersions(url)`                                                                 | `/api/versions` fetch with rate-limit/offline error lines; preserves the last known list on failure                                                                                                                                                                        |
| `useUpdateFlow({ checkUrl, applyUrl })`                                            | The check/apply state machine behind `UpdateControls`, for custom layouts                                                                                                                                                                                                  |
| `splitVersions`, `shownTags`, `runningTagFallback`, `deriveVersionsView`           | The pure dropdown view-logic (unit-tested without a DOM)                                                                                                                                                                                                                   |
| `formatUpdateMessage`, `formatTimeAgo`, `formatNumber`                             | `UpdateCheckResult` → status line ("Update available: 1.0.0 → 1.1.0", "Offline — last checked 3h ago…"), relative timestamps, compact counts ("1.2K")                                                                                                                      |

### Panel conventions the components encode

Adopt these even where you don't use the components:

- **A controlled `<select>` must always render its value.** If the running
  tag isn't in the options (a GitHub rate limit hid it, or a pin fell out of
  the top-N), inject a synthetic option — otherwise the browser shows the
  first option and the next Save silently changes the running image.
- **Version lists degrade, never wipe.** On a failed `/api/versions` fetch,
  keep showing the last known list with an explanatory error line.
- **Poll by self-scheduling, not `setInterval`.** On a slow host one response
  can outlast the poll period; the next request must only start after the
  previous one settled. Drop stale responses with a generation counter.
- **Parse status bodies on non-2xx.** Unhealthy responses (503) often carry
  the very fields the operator needs to fix the problem.
- **Offline is a state, not an error.** Boats lose connectivity; show "last
  checked 3h ago", don't paint the panel red.
- **Persist the requested tag, not the resolved one** after an update, so
  floating tags like `latest` keep auto-tracking.
- **Match the remote's module format to your package's `type` field.** The
  server injects `<script type="module">` for `"type": "module"` plugins and
  a plain script tag otherwise; the wrong webpack `library` type fails only
  at panel-open time, with a misleading "webapp is not installed" error (see
  [ESM plugins must build an ESM remote](#esm-plugins-must-build-an-esm-remote)).

## API overview

| Export                          | Purpose                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ManagedContainer`              | Full lifecycle: `start`, `stop`, `applyUpdate`, `checkForUpdate`, `getState`, `getInfo`, `resolveAddress`, `getLogs`, `registerUpdateRoutes`                                                                                                                                             |
| `AdoptedContainer`              | Update registration + checks for externally-managed containers                                                                                                                                                                                                                           |
| `getContainerManager()`         | Read the `globalThis.__signalk_containerManager` global                                                                                                                                                                                                                                  |
| `waitForContainerManager(opts)` | Two-phase wait (manager present → runtime settled); returns `{ manager, runtime }` so the two failure modes get distinct messages                                                                                                                                                        |
| `waitForHttpReady(url, opts)`   | Poll until 2xx or deadline (throws)                                                                                                                                                                                                                                                      |
| `retryForever(fn, opts)`        | Retry until success — 15s doubling to a 120s ceiling, no attempt cap. `ManagedContainer` takes it as `readinessRetry`; exported standalone for work this library does not manage                                                                                                         |
| `anySignal(signals)`            | Compose several `AbortSignal`s into one that aborts when any does (`undefined` when none are given)                                                                                                                                                                                      |
| `probeHttpHealth(url, opts)`    | Retrying liveness probe with slow-response detection (never throws)                                                                                                                                                                                                                      |
| `fetchWithTimeout(url, opts)`   | `fetch` with an `AbortController` timeout                                                                                                                                                                                                                                                |
| `throwIfAborted(signal)`        | Throw `ContainerHelperError` `cancelled` if the signal has fired — the check the lifecycle methods run between steps                                                                                                                                                                     |
| `startSafely(app, fn)`          | Sync wrapper for async plugin startup — Signal K does not await `start()`                                                                                                                                                                                                                |
| `isValidImageTag(tag)`          | Tag guard (`IMAGE_TAG_PATTERN`)                                                                                                                                                                                                                                                          |
| `errMsg(err)`                   | Normalize unknown errors to strings                                                                                                                                                                                                                                                      |
| `ContainerHelperError`          | Typed error with `code` and `reported`                                                                                                                                                                                                                                                   |
| Types                           | Local mirror of signalk-container's public API — `ContainerManagerApi`, `ContainerConfig`, `EnsureRunningOptions`, `UpdateServiceApi`, … — verified at build time against `signalk-container/types` (≥ 1.23.2) so it never silently drifts. Feature-detected members stay optional here. |

### Error codes

`ContainerHelperError.code` values thrown by `start()` / `applyUpdate()`:

| Code                  | Meaning                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manager-unavailable` | signalk-container never published its API within the budget                                                                                                               |
| `no-runtime`          | Manager present, but no podman/docker was detected                                                                                                                        |
| `invalid-tag`         | Tag failed the `IMAGE_TAG_PATTERN` guard                                                                                                                                  |
| `address-unresolved`  | No host:port could be found for the readiness port                                                                                                                        |
| `not-ready`           | The app never answered its health URL before the deadline                                                                                                                 |
| `recreate-limbo`      | Legacy update path removed the container but recreation failed — retry applies                                                                                            |
| `cancelled`           | The `AbortSignal` passed to the operation fired, or a newer lifecycle operation superseded a retrying `start()` (see [Cancelling an operation](#cancelling-an-operation)) |
| `invalid-option`      | An option could not produce sane behaviour — e.g. a non-finite or negative `retryForever` delay bound                                                                     |

All errors thrown by the helpers have already been surfaced through
`app.setPluginError` (`reported: true`), so `startSafely` won't report them twice.

### Cancelling an operation

`start()` and `applyUpdate()` take an optional second argument carrying an
`AbortSignal`:

```ts
const abort = new AbortController();

// in start():
startSafely(app, () =>
  container.start(settings.imageTag, { signal: abort.signal }),
);

// in stop():
abort.abort(); // unblocks an in-flight start
await container.stop();
```

`stop()` takes no signal: it has nothing cancellable — an unregister call and
one uninterruptible `manager.stop` — so accepting one would promise what it
cannot deliver. It is still serialized against the other operations.

An aborted operation rejects with `ContainerHelperError` code `cancelled`,
already flagged `reported`, so `startSafely` logs it at debug rather than
putting a plugin error on screen for something you asked for.

**Cancellation is cooperative, not pre-emptive.** signalk-container's
`ensureRunning`, `recreate` and `stop` take no signal — only its one-off job
API does — so a call already in flight runs to completion. What the signal
cancels is everything around it: waiting for the manager global, the drift
probe, readiness polling, and each step boundary. That is where the time
actually goes, since those are the polls with deadlines measured in minutes,
and it is what stops an abandoned start from continuing to work against a
container you have already torn down.

Operations are also **serialized per instance**. An overlapping `start` and
`stop` — a plugin restarted while its first start is still waiting on
readiness — queue rather than interleave, so `stop` can no longer land between
`ensureRunning` and the readiness poll and leave the plugin believing it
started something it just removed. Callers that already hold their own
lifecycle lock see no change.

### Retrying forever

`start()` throws once when bring-up fails, which is right for a plugin that
reports the problem and waits for a human. Where no human may be coming, pass
`readinessRetry`:

```ts
const container = new ManagedContainer({
  // …
  readinessRetry: {
    onAttemptFailed: (err, nextDelayMs) =>
      app.setPluginError(
        `Backup server unreachable: ${errMsg(err)} — retrying in ${Math.round(nextDelayMs / 1000)}s`,
      ),
  },
});

// Resolves only on success; rejects on cancellation, on an invalid delay
// bound, or if your onAttemptFailed callback itself throws.
const { address } = await container.start(tag, { signal });
```

`start()` then retries the whole bring-up — 15s doubling to a 120s ceiling,
indefinitely. A container that lost a boot race should not stay down until
someone restarts the plugin; on a boat that can be weeks. Each attempt re-runs
`start()` whole, which is safe because `ensureRunning` is idempotent, and
necessary because a container that only just came up may bind a different host
port than the last attempt saw.

Use `onAttemptFailed` to keep the status line honest — the returned promise
stays pending either way, so without it an operator cannot tell "still
retrying" from "stuck".

Pair it with a `signal`: cancellation is the only exit besides success. Both
the per-call `signal` and `readinessRetry.signal` are honoured — aborting
either ends the loop, and an abort during a backoff settles immediately rather
than waiting the delay out.

Each attempt is serialized individually rather than the loop as a whole, so a
retry sleeping between attempts never blocks `stop()`. A later lifecycle
operation also retires the loop: a `start()` still retrying an old tag stands
down when `applyUpdate()` or `stop()` runs, instead of restarting the container
on the image the operator just moved away from.

`retryForever` is exported on its own for the same policy applied to work this
library does not manage — an external service a plugin points at but does not
own, for instance.

### Version compatibility

The helpers feature-detect newer signalk-container capabilities:

| Capability                                             | Floor  | Fallback behavior                                            |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `whenReady()`                                          | 1.6.0  | polls `getRuntime()`                                         |
| `getLogs()`                                            | 1.7.0  | `getLogs()` returns `null`                                   |
| `recreate()`                                           | 1.12.0 | self-heal skipped; updates use pull → remove → ensureRunning |
| `ContainerConfig.healthcheck`                          | 1.14.0 | ignored by older versions                                    |
| `ContainerConfig.ulimits`                              | 1.17.0 | ignored by older versions                                    |
| `ContainerConfig.devices` / `ContainerConfig.groupAdd` | 1.24.0 | ignored by older versions                                    |

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
2. Run `npm run release` — it tags `v<version>` and pushes the tag.
3. The workflow creates a GitHub Release whose notes are generated from the PRs merged since the previous tag (grouped by `.github/release.yml`), then builds, tests, and runs `npm publish --provenance` (tags containing `alpha`/`beta`/`rc` publish under the matching dist-tag).

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no npm token secret, but the package must list this repo's workflow as a trusted publisher on npmjs.com.

## License

Apache-2.0
