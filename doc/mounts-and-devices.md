# Mounts and host devices

## Mounting your plugin's own data directory

`signalkDataMount` does **not** mount your plugin's data directory. Signal K
rewrites `app.getDataDirPath()` per plugin, and signalk-container resolves that
field from _its own_ app object — so you get
`<configRoot>/plugin-config-data/signalk-container/`, not yours.

| You want                                      | Use                                              |
| --------------------------------------------- | ------------------------------------------------ |
| A private writable area in the SK data tree   | `signalkDataMount` (signalk-container's)         |
| The whole SK config root                      | `signalkConfigRootMount` (incl. `security.json`) |
| **Your own plugin's data dir**                | **`resolveMount()`** + a `volumes` entry         |
| **Is there a GPU / device on the host?**      | **`probeHostDevice()`**                          |
| **Which USB serial devices are plugged in?**  | **`listHostSerialDevices()`**                    |
| **Act when a USB device is pulled/replugged** | **`watchHostDevice()`**                          |

Either mount field resolves to a host path or a named volume, depending on the
deployment. A named volume always arrives whole: signalk-container sends no
subpath, and podman's Docker-compat endpoint ignores one anyway (Docker Engine
honours it, so narrowing cannot be made to work uniformly). signalk-container
1.32.0+ therefore accepts a volume only when it is attached to the directory
being requested — a volume covering a parent would hand your container the
volume's entire contents, and `ensureRunning` throws instead. Below 1.32.0 that
case is mounted rather than refused. `resolveMount()` is the way in if you want
the wider scope deliberately: it reports `subPath`, so the choice is yours.

`resolveMount` translates any absolute host path into a mount the container
runtime can actually bind, on bare-metal and containerized Signal K alike:

Because `buildConfig` is synchronous, resolve the mount inside `startSafely`
before constructing the container — `resolveMount` failures then propagate
through `startSafely` like any other startup error:

```ts
import {
  ManagedContainer,
  resolveMount,
  startSafely,
  waitForContainerManager,
} from "signalk-container-helper";

start(rawConfig) {
  startSafely(app, async () => {
    // ManagedContainer normally acquires the manager itself; here you need
    // it up front, because buildConfig cannot await.
    const { manager } = await waitForContainerManager();
    if (!manager) throw new Error("signalk-container is not installed");

    const data = await resolveMount(manager, {
      containerPath: "/data",
      hostPath: app.getDataDirPath(), // YOUR plugin's app
    });

    container = new ManagedContainer({
      app,
      pluginId: "signalk-myservice",
      name: "myservice",
      image: "ghcr.io/example/myservice",
      buildConfig: (tag) => ({
        image: "ghcr.io/example/myservice",
        tag,
        volumes: { "/data": data.source },
        // data.containerPath, NOT "/data" — see below
        command: ["service", "--config", `${data.containerPath}/config.yml`],
      }),
    });

    await container.start(rawConfig.imageTag);
    app.setPluginStatus("Running");
  });
}
```

**Use `data.containerPath` for paths inside the container, not the mount point
you asked for.** When Signal K's data dir lives on a _named volume_, container
runtimes cannot bind a subdirectory of it, so the mount root is the volume and
`subPath` is the offset to your directory — `containerPath` has that already
joined. For bind mounts `subPath` is `""` and `containerPath` equals what you
passed. Ignoring it works on bare-metal and bind-mounted Docker, then silently
reads the wrong directory on a named-volume deployment.

## Devices on the host

`probeHostDevice(manager, path)` answers whether the **host** has a device,
which a plugin cannot determine itself — `stat("/dev/dri")` describes the
plugin's own filesystem, and that is the Signal K container whenever Signal K
is containerized:

```ts
import { probeHostDevice } from "signalk-container-helper";

const gpu = await probeHostDevice(manager, "/dev/dri");
if (gpu?.exists) {
  config.devices = ["/dev/dri"];
  config.groupAdd = gpu.groups; // names, resolved on the host
}
```

`null` means **unknown** (no runtime, or the host could not be read) and is
deliberately distinct from `{ exists: false }` — assume no device, but do not
report it as absent. Throws `ContainerHelperError('unsupported-manager')` on
signalk-container older than 1.30.0, so catch it if you would rather degrade
than fail. Works on both Docker and rootless podman.

### USB devices that come and go

A container gets its device nodes when it is created. Pull a USB stick while
it runs and the program inside usually exits, and `unless-stopped` restarts it
against a node that is gone; plug it back in and it may come up as another
node (`ttyUSB1` for `ttyUSB0`) that the old container never sees.

`listHostSerialDevices(manager)` lists the host's `/dev/serial/by-id` links as
full, sorted paths. Their names carry vendor, product and serial number, so a
plugin can recognise its hardware without asking the user for a path, and the
link is the path to pass to the container: it survives a replug that changes
the `ttyUSB` number. `[]` means nothing is plugged in, `null` that the host
could not be asked. A containerized Signal K needs signalk-container 1.37.2 or
later to list the links.

`watchHostDevice(options)` follows one device and tells the plugin when to act;
what acting means stays with the plugin:

```ts
import { watchHostDevice } from "signalk-container-helper";

const abort = new AbortController();
const watch = watchHostDevice({
  manager,
  path: "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_…",
  isStarted: () => started,
  isHealthy: () => bridge.online, // undefined when you cannot tell
  onEvent: async (event) => {
    if (event === "unplugged") await manager.stop(name);
    // pluggedIn or stuck: recreate, without `pull: true`, so a plug event
    // keeps the image the host has
    else await container.applyUpdate(tag, { signal: abort.signal });
  },
});
// in plugin.stop():
abort.abort(); // ends a recreate the handler is waiting on, if any
await watch.stop();
```

| Event       | When                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| `unplugged` | The device went away under a started container. Once per unplug.                          |
| `pluggedIn` | The device is back after an unplug, or appeared while nothing was started.                |
| `stuck`     | The device is there and the workload stayed unhealthy for `stuckMs`. Repeats until fixed. |

The host is probed only while the container is not started or not healthy,
so a working setup costs nothing (a probe is a short-lived container under a
containerized Signal K). A probe that cannot tell changes nothing, and with
health unknown no `stuck` is raised. Ticks run every `intervalMs` (default
30 s, the first one interval after the call), handlers never overlap, a
throwing handler is logged through `debug`, and `stop()` waits for a tick in
progress, including a handler still running (from inside `onEvent` it returns
at once). So abort whatever the handler may be waiting on before awaiting
`stop()`: a recreate with `readinessRetry` ends only on its signal. Pass
`initiallyAbsent: true` when the device was missing at start, so its arrival
is reported as `pluggedIn`. `decideDeviceEvent` is the pure decision behind
it, exported for plugins that run their own timer.
