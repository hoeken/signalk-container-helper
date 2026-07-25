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
