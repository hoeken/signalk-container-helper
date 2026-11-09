# Config-panel UI (`signalk-container-helper/ui`)

The reference plugins also share a hand-copied React config panel: a container
status card, an image-version dropdown, a check/apply update row, and the same
inline-style vocabulary. The `/ui` entrypoint packages those as reusable
components and hooks. It is a separate subpath export — the main entry stays
Node-only and zero-dependency; `/ui` needs `react` (an optional peer
dependency) and runs in the Signal K Admin UI page.

## How it fits the standard panel build

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

## ESM plugins must build an ESM remote

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

## Example panel

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

## UI exports

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

## Panel conventions the components encode

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
- **Tie a form error to the field it is about.** `ActionStatus` announces
  its message to screen readers (an alert for an error, a polite status for a
  success). Give it an `id` and, while the error stands, set `aria-invalid`
  and `aria-describedby` on the field so the message is read with it:

  ```jsx
  <input
    aria-invalid={rateError ? true : undefined}
    aria-describedby={rateError ? "save-status" : undefined}
  />
  <ActionStatus id="save-status" message={rateError || saved} error={!!rateError} />
  ```

- **Match the remote's module format to your package's `type` field.** The
  server injects `<script type="module">` for `"type": "module"` plugins and
  a plain script tag otherwise; the wrong webpack `library` type fails only
  at panel-open time, with a misleading "webapp is not installed" error (see
  [ESM plugins must build an ESM remote](#esm-plugins-must-build-an-esm-remote)).
