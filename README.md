# signalk-container-helper

A typed, zero-dependency library for [Signal K](https://signalk.org) plugins
that run a container through the
[signalk-container](https://github.com/dirkwa/signalk-container) plugin.

Every such plugin ends up writing the same code: wait for the container manager,
start the container, wait until the app inside answers, check for image updates,
and stop cleanly. This library does it in a few lines. It was extracted from
`signalk-backup`, `mayara-server-signalk-plugin`, `signalk-doctor` and
`signalk-updater`.

A second entry point, `signalk-container-helper/ui`, has the React building
blocks for the config panel: a container status card, an image-version dropdown
and update controls.

The design rationale is in [SPEC.md](SPEC.md).

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

At runtime it works with signalk-container 1.6.0 or newer. Newer manager
features are detected, with a fallback where they are missing; see
[Version compatibility](doc/api.md#version-compatibility).

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

    async stop(options) {
      // unregister updates + stop (not remove); keeps it running when the
      // server shuts down; never throws
      await container?.stop(options);
      app.setPluginStatus("Stopped");
    },

    registerWithRouter(router) {
      // GET  /plugins/signalk-myservice/api/update/check
      // POST /plugins/signalk-myservice/api/update/apply   { tag?: string }
      //      no tag: the one the container was started with, e.g. "auto";
      //      pulls the tag, then recreates (applyUpdate with pull: true);
      //      409 while the plugin is stopped (the route stays mounted)
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

`start()` waits for signalk-container, checks the tag, starts the container or
brings it in line with `buildConfig`, registers it for update checks, and waits
until the app answers on its readiness port.
[What `start()` does](doc/managed-container.md#what-start-does) lists the steps
and how errors are reported.

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

## What do I need for…

| You want to                                               | Use                                            | Read                                                                              |
| --------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| Mount your plugin's own data directory into the container | `resolveMount()`                               | [Mounts](doc/mounts-and-devices.md#mounting-your-plugins-own-data-directory)      |
| Pass a GPU or another host device to the container        | `probeHostDevice()`                            | [Host devices](doc/mounts-and-devices.md#devices-on-the-host)                     |
| Follow a USB device that is unplugged and plugged back in | `listHostSerialDevices()`, `watchHostDevice()` | [USB devices](doc/mounts-and-devices.md#usb-devices-that-come-and-go)             |
| Let the operator run the service on another machine       | `resolveEndpoint()`, `managedModeSchema()`     | [Managed or self-hosted](doc/self-hosted.md)                                      |
| Build the config panel                                    | `signalk-container-helper/ui`                  | [Config panel](doc/config-panel.md)                                               |
| Keep trying until the container comes up                  | `readinessRetry`, `retryForever()`             | [Retrying forever](doc/managed-container.md#retrying-forever)                     |
| Cancel a start or an update                               | the `signal` option                            | [Cancelling](doc/managed-container.md#cancelling-an-operation)                    |
| Update a container on `latest` after your plugin updates  | `updateImageAfterPluginUpdate()`               | [Image update](doc/managed-container.md#updating-the-image-after-a-plugin-update) |
| Tell errors apart                                         | `ContainerHelperError.code`                    | [Error codes](doc/api.md#error-codes)                                             |
| See every export                                          |                                                | [API reference](doc/api.md)                                                       |

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

This is a strict TypeScript project, tooling configs included; see
[CONTRIBUTING.md](CONTRIBUTING.md) before you send a change.

## Releasing

Consumers install the library from npm with a semver range; `main` is the
development trunk. Releases are made by release-please from the titles of the
PRs merged to `main`, and published to npm by CI. Nothing is bumped, tagged or
published by hand; the steps are in [AGENTS.md](AGENTS.md#release-process).

## License

Apache-2.0
