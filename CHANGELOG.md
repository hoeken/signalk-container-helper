# v0.4.3

- **`SelfDeploymentResult` is mirrored in full**, and `SelfDeploymentStatus`
  gains the `cgroup-controllers-incomplete` variant it was missing. The
  interface previously carried only `status` and `remediation` behind an
  `[key: string]: unknown` index signature, so it looked complete while
  typing every other field as `unknown` — a consumer reading
  `isContainerized`, the field `doctor.selfDeployment()` exists for, got
  neither a value nor an error. Ten fields were absent.

  Both types are now pinned in the contract test, which fails against the old
  shape. Found by a consumer whose own (correct) type disagreed with the
  mirror — see #27 for the coverage gap that let it drift.

# v0.4.2

- **`ContainerManagerApi.getContainerNofile` is mirrored** (signalk-container
  1.25.3+), along with its `NofileLimits` return type. It reports the nofile
  limits a container is actually running with, which is how a plugin clears a
  stale "capped by the host" ulimit advisory once the container does get the
  full requested limit. Optional, so feature-detect it. Without this a
  consumer had to hand-declare the method and intersect it with the mirrored
  interface — the drift the mirror exists to prevent.

# v0.4.1

- **`CollapsibleSection` headers read as controls.** The header button
  inherited `sectionTitle`'s muted `#888`, so a collapsed section looked like
  a caption rather than something to click — a signalk-questdb user reported
  a config field as uneditable when it was only collapsed
  ([dirkwa/signalk-questdb#123](https://github.com/dirkwa/signalk-questdb/issues/123)).
  The chrome moves into two new exported styles, `sectionToggle` (which
  overrides the colour to `#555`, the same tone as `label`) and
  `sectionMarker` (an 11px disclosure triangle, up from 10px). Every panel
  using `CollapsibleSection` picks this up; nothing else changes.

# v0.4.0

- **`start()` and `applyUpdate()` accept an `AbortSignal`** via a new optional
  `OperationOptions` argument. (`stop()` does not: it has nothing cancellable,
  so accepting one would promise what it cannot deliver.) An aborted operation rejects with
  `ContainerHelperError` code `cancelled`, flagged `reported` so `startSafely`
  logs it rather than surfacing a plugin error for a stop the caller asked for.

  Cancellation is **cooperative**: signalk-container's `ensureRunning`,
  `recreate` and `stop` take no signal (only its one-off job API does), so a
  call already in flight runs to completion. The signal cancels everything
  around it — the manager-global wait, the drift probe, readiness polling, and
  each step boundary. Those are the waits with minute-scale deadlines, and
  cancelling them is what stops an abandoned start from continuing to work
  against a container the caller has already torn down.

  `waitForContainerManager` and `waitForHttpReady` take a `signal` too, so
  their poll loops exit promptly instead of running out their full budget.
  An aborted `waitForHttpReady` throws an `AbortError` (a `DOMException`,
  matching what `fetch` itself throws) rather than its deadline error — a
  caller that cancelled must be able to tell "I stopped this" from "the app
  never came up", or a container it deliberately tore down surfaces a
  readiness failure.

- **Lifecycle operations are serialized per `ManagedContainer`.** An
  overlapping `start` and `stop` — a plugin restarted while its first start is
  still waiting on readiness — now queue instead of interleaving, so `stop`
  cannot land between `ensureRunning` and the readiness poll and leave the
  plugin believing it started something it just removed. Callers that already
  hold their own lifecycle lock see no behaviour change.

  Every consumer plugin had built this itself; it belongs in the library.

# v0.3.1

Maintenance release. One small change reaches the published package; the rest of
the work since 0.3.0 was tooling and documentation that does not ship.

- **`useStatusPoll` schedules its repeat poll through an explicit void wrapper** —
  `setTimeout(poll, intervalMs)` became `setTimeout(() => void poll(), intervalMs)`.
  Behaviour is unchanged: the surrounding effect already handled the async
  correctly, with `void` on the initial call, a `cancelled` guard before
  rescheduling, and `AbortController.abort()` on cleanup. This makes the
  intent explicit rather than fixing a live defect, and satisfies
  `@typescript-eslint/no-misused-promises`
- **`fetchWithTimeout` drops an unnecessary `fetch as unknown as FetchLike`
  double assertion** — `fetch` already satisfies `FetchLike`. Type-only change;
  the emitted JavaScript is byte-identical
- Internal, not shipped: eslint moved to the type-checked tier, which is what
  surfaced both items above; `package-lock.json` is no longer committed (CI
  generates one per run, matching the signalk-server pattern); `AGENTS.md` and
  `CLAUDE.md` document the repo's conventions and release process

# v0.3.0

- **Node floor lowered to `>=22`** (was `>=24`) — nothing in the library ever required Node 24: the main entry imports no Node builtins at all, and the only runtime globals it touches (`fetch`, `AbortController`, a plain `setTimeout`-based timeout in `fetchWithTimeout`, `URL`, `globalThis`) predate Node 22 comfortably. There is no `AbortSignal.any()` / `AbortSignal.timeout()`, no `node:sqlite`, and the compiler targets ES2023. The old floor was a policy value that consumers — Signal K plugins, which inherit their host server's Node — had to satisfy for no technical reason. This is a **minor**, not a patch: it widens the supported range and takes nothing away, so Node 24 consumers are unaffected
- **The floor is now enforced rather than asserted** — CI builds, tests, and lints on a `["22", "24"]` matrix instead of Node 24 alone, and `@types/node` drops to `^22` so the typechecker fails on any Node 24-only API that gets introduced later. Previously the package claimed a floor that nothing verified

# v0.2.2

Maintenance release — dependency updates only, no changes to the library's public API or runtime behaviour.

- **TypeScript 6** — the dev toolchain moves from `^5.5.0` to `^6.0.3`; the emitted declarations and ESM output are unchanged, and the full build, 96-test suite, and lint chain pass under the new compiler
- **`signalk-container` type source bumped 1.23.2 → 1.25.2** — the contract test that pins this library's type mirror against `signalk-container/types` still passes, so the mirrored `ContainerManagerApi` / `ContainerConfig` / `UpdateServiceApi` surface has not drifted against the newer manager
- Dev-dependency refresh: `eslint` 10.7.0 → 10.8.0, `typescript-eslint` 8.65.0 → 8.66.0, `globals` 17.7.0 → 17.9.0, `@types/react` 19.2.17 → 19.2.18
- CI: `actions/checkout` and `actions/setup-node` bumped to v7 in the publish workflow

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
