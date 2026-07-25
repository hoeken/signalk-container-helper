# v0.2.1

Docs-only release.

- **README: "ESM plugins must build an ESM remote"** — Signal K injects each configurator panel's script tag based on the plugin's package.json `type` field, so `"type": "module"` plugins (like this library, and therefore most of its consumers) must build their panel as an ESM Module Federation container (`experiments.outputModule` + `output.module` + `library: { type: "module" }`); the classic `var` remote the CommonJS reference plugins use loads silently into module scope and fails at panel-open time with the misleading _'Module "…" is not available. Make sure the webapp is installed.'_ The new section documents the server's injection logic, both mismatch failure modes, the webpack recipe, a `get`/`init` verification one-liner, and links [signalk-piper](https://github.com/hoeken/signalk-piper) as a working ESM example — plus a matching panel-conventions bullet, and the "no changes to the standard webpack config" claim is now scoped to loaders

# v0.2.0

- **New `signalk-container-helper/ui` entrypoint** — browser-side React building blocks for plugin config panels, packaging the pieces the reference plugins (`signalk-grafana`, `signalk-questdb`, `mayara-server-signalk-plugin`) had each been hand-copying: the shared inline-style vocabulary (`panelStyles`, `stateColors`), components (`StatusCard`, `VersionSelect`, `UpdateControls`, `Button`, `CollapsibleSection`, and friends), fetch-and-poll hooks (`useStatusPoll`, `useVersions`, `useUpdateFlow`) with self-scheduling polls and stale-response drops, version-dropdown view logic (`deriveVersionsView`) that handles both structured and legacy `/api/versions` shapes and falls back to the running tag so a rate-limited GitHub fetch never blanks the select, and `formatUpdateMessage` typed against `UpdateCheckResult` to match `registerUpdateRoutes`' contract
- The UI entry ships as tsc-compiled `React.createElement` ESM (no JSX) so panel webpack builds that exclude `node_modules` from babel-loader can bundle it directly; `react` (≥ 17) is a new **optional** peer dependency that resolves to the Admin UI's Module Federation shared singleton — the main entry remains Node-only and zero-dependency
- **Type mirror** — added `ContainerConfig.devices` and `ContainerConfig.groupAdd`, mirroring signalk-container 1.24.0 (older manager versions silently ignore both fields)

# v0.1.0

Initial release — a typed, zero-dependency helper library for Signal K plugin developers whose plugins run containers through the [signalk-container](https://github.com/dirkwa/signalk-container) plugin, packaging the integration patterns extracted from `signalk-backup`, `mayara-server-signalk-plugin`, `signalk-doctor`, and `signalk-updater`.

- **`ManagedContainer`** — the full owned-container lifecycle: image-tag validation, `ensureRunning`, waiting for the app inside the container to answer HTTP, update-detection registration, `/api/update/check` + `/api/update/apply` routes, log access, and clean shutdown
- **`AdoptedContainer`** — update registration and update checks for containers the plugin doesn't own
- **Manager discovery** — `getContainerManager` plus `waitForContainerManager`, a two-phase wait (manager present → runtime settled) that keeps the two failure modes distinct in error reporting
- **Declarative update sources** — `buildVersionSource` resolves a GitHub-releases, Docker-Hub-tags, or custom spec against the manager's update service
- **HTTP utilities** — `fetchWithTimeout`, `waitForHttpReady` (poll until 2xx or deadline), and `probeHttpHealth` (retrying liveness probe with slow-response detection that never throws)
- **Startup helper** — `startSafely` wraps async plugin startup so failures are caught and reported even though Signal K doesn't await `start()`
- **Typed errors** — `ContainerHelperError` with stable error codes, plus the `errMsg` and `isValidImageTag` guards
- **Type mirror of signalk-container's public API** — `ContainerManagerApi`, `ContainerConfig`, `UpdateServiceApi`, and friends, verified against `signalk-container/types` (≥ 1.23.2) by a contract test so the mirror can't silently drift
- Ships as an ES module and requires Node ≥ 24
