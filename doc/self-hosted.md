# Managed or self-hosted

Some operators would rather run the service themselves — on a NAS, another Pi, or
a box that is already doing the job — and point the plugin at it. That is a
config switch (`managedContainer`) plus an address, and every plugin that offers
it had written its own.

**Scope, precisely:** this means the _service_ runs elsewhere. It does **not**
mean a container _engine_ elsewhere — signalk-container talks to local unix
sockets only and rejects a `tcp://` endpoint, so there is no remote-engine mode
to opt into.

```ts
import {
  resolveEndpoint,
  waitForEndpointReady,
  isManagedMode,
} from "signalk-container-helper";

const endpoint = await resolveEndpoint({
  managed: settings.managedContainer, // pass the RAW config value
  externalUrl: settings.externalUrl,
  container, // a started ManagedContainer; managed mode only
  port: 3020,
  productName: "signalk-tailscale-server",
});

await waitForEndpointReady(endpoint, { path: "/api/health" });
const client = new ShimClient(endpoint.baseUrl);
```

`endpoint.baseUrl` is scheme-ful with no trailing slash in both modes, so the
transport half of your plugin stops caring which mode it is in. `endpoint.mode`
is there for the parts that legitimately differ.

## If you drive `ensureRunning` yourself

`container` is for plugins that hand their lifecycle to `ManagedContainer`.
Plenty do not — calling `ensureRunning`/`pullImage`/`stop` directly is a
perfectly good pattern, and address resolution needs none of that lifecycle.
Give a `containerName` instead:

```ts
const endpoint = await resolveEndpoint({
  managed: settings.managedContainer,
  externalUrl: settings.externalUrl,
  containerName: CONTAINER_NAME, // unprefixed
  manager, // optional; defaults to the globalThis one
  port: API_PORT,
  productName: "signalk-tailscale-server",
  debug: (msg) => app.debug(msg),
});
```

`endpoint.container` is null in that form. Use `endpoint.mode` to decide
managed-versus-external behaviour, and null-check `container` separately
before touching it — `mode === "managed"` does not imply a container is
there.

`resolveContainerEndpoint(manager, name, port, debug?)` is exported on its own
if you only want the address. It asks the manager first and falls back to
parsing `listContainers()` port bindings — the resolver's process-local cache
can go stale after a recreate, and it _throws_ (rather than returning null)
when the port was declared in `signalkAccessiblePorts` but `ensureRunning()`
has not run yet. Both are handled; it never throws.

It also matches the live container by `unprefixedName`, falling back to any
`<namespace>-<name>` form. A hand-rolled `sk-<name>` comparison — which is what
the copies of this logic tended to be — silently finds nothing under a
non-default `SIGNALK_CONTAINER_NAMESPACE`.

## Pass the raw config value

`managed` is `boolean | undefined`, and **`undefined` means managed**. Signal K
calls `plugin.start()` with `{}` when a plugin is enabled without its form ever
being saved, so `Boolean(config.managedContainer)` would flip exactly those
installs into self-hosted mode with an empty URL — a plugin that used to work
now errors on enable. Use `isManagedMode(...)` anywhere you need the mode
question on its own (route guards, status fields).

## Readiness retries are opt-in

`waitForEndpointReady` makes **one** attempt unless you pass `retry`. The
reference plugins genuinely differ here — one retries forever because an
unattended boat has to heal itself, another reports once and waits for the
operator — so neither behaviour is imposed:

```ts
await waitForEndpointReady(endpoint, {
  path: "/api/health",
  signal,
  retry: {
    minDelayMs: 15_000,
    onAttemptFailed: (err, next) =>
      app.setPluginError(
        `${endpoint.baseUrl} unreachable: ${errMsg(err)} — retrying in ${Math.round(next / 1000)}s`,
      ),
  },
});
```

## The config fields

`managedModeSchema` emits the two form fields as **plain JSON Schema**. It has to
be plain: consumers are split between `typebox` 1.x and `@sinclair/typebox` 0.34,
which are mutually incompatible, and this library depends on neither.

Splice each fragment with `Type.Unsafe`. The call is written identically in both
packages:

```ts
import { Type, type Static } from "@sinclair/typebox"; // or "typebox"
import { managedModeSchema } from "signalk-container-helper/schema";

const MODE = managedModeSchema({
  productName: "signalk-tailscale-server",
  image: "ghcr.io/dirkwa/signalk-tailscale-server",
  exampleUrl: "http://192.168.1.50:3020",
});

export const ConfigSchema = Type.Object({
  managedContainer: Type.Unsafe<boolean>(MODE.managedContainer),
  externalUrl: Type.Unsafe<string>(MODE.externalUrl),
  // …your own fields
});

export const SCHEMA_DEFAULTS: Config = {
  ...MODE.defaults, // { managedContainer: true, externalUrl: "" }
  // …your own defaults
};
```

## Hiding the URL field when it does not apply

By default the URL field is always rendered, including while the container is
managed — where it does nothing. Splice in `dependencies` to have it appear
only when the toggle is off:

```ts
import {
  managedModeSchema,
  type WithExternalUrl,
} from "signalk-container-helper/schema";

// NOTE: externalUrl is deliberately NOT in `properties` — see below.
export const ConfigSchema = Type.Object(
  {
    managedContainer: Type.Unsafe<boolean>(MODE.managedContainer),
    // …your own fields
  },
  { dependencies: MODE.dependencies },
);

export type Config = WithExternalUrl<Static<typeof ConfigSchema>>;
```

**`externalUrl` must be left out of `properties`.** RJSF renders everything in
`properties` regardless of what the dependency says, so leaving it there means
the field never hides — the dependency simply has no effect.

That has a consequence worth knowing: TypeBox derives `Static<>` from
`properties` alone, so the field would drop out of your `Config` type and
every `settings.externalUrl` read would stop compiling. `WithExternalUrl` adds
it back. Pass the field name as a second argument when it is not
`externalUrl`:

```ts
export type Config = WithExternalUrl<Static<typeof S>, "serverUrl">;
```

`SCHEMA_DEFAULTS` is unaffected — `...MODE.defaults` still supplies both keys.

This is live — RJSF re-evaluates `dependencies` on every change, so the field
appears the instant the toggle is switched off. A `uiSchema` `ui:disabled`
cannot do that: a plugin's uiSchema is fetched once when the form loads, so a
greyed-out field would stay greyed until a page reload.

Optional. Omit `dependencies` to keep the field always visible.

`Type.Unsafe` is not optional. A bare fragment spread straight into
`Type.Object({...})` compiles under `typebox` 1.x and **fails** under
`@sinclair/typebox` 0.34 (`missing the following properties from type
'TSchema': params, static, [Kind]`).

Two things to know about it. It **asserts** the static type rather than deriving
it, so keep the type argument and the fragment's `type` in step — nothing checks
that for you. And `Type.Unsafe` emits the same keys and values as
`Type.Boolean`/`Type.String` but in a different **order** (`type` first rather
than last); that is meaningless to JSON Schema and to the Admin UI's form
renderer, so compare with sorted keys if you assert on the emitted schema while
migrating.

### Why not just move every plugin to `typebox` 1.x?

Because it would not remove the split. `@signalk/server-api` depends on
`@sinclair/typebox` 0.34 itself, so the scoped package sits in every consumer's
dependency tree regardless of which one the plugin picks for its own schema —
`signalk-questdb` already resolves **both** today. Migrating a plugin adds a
second TypeBox beside the first rather than replacing it.

Migrating is still reasonable on its own merits: `@sinclair/typebox` is frozen
at 0.34.52 (TypeBox 1.x was republished under the unscoped `typebox` name
instead of taking a major bump), so plugins on the scoped package are on a line
that receives no further fixes. For the constructs these plugins actually use —
`Object`, `String`, `Boolean`, `Number`, `Literal`, `Union`, `Array` — the two
versions emit semantically identical JSON Schema (verified; only key order
differs), and `Type`/`Static` import the same way, so it is a per-plugin import
swap rather than a port.

What it is not is a prerequisite for this API. Emitting plain JSON Schema keeps
this module out of the question entirely, and works before, during and after any
such migration.

Spreading `MODE.defaults` matters because Signal K uses a schema `default` only
to seed the _form_, never the config object a plugin receives — which is why
every consumer hand-writes a `SCHEMA_DEFAULTS` beside its schema, and why those
two drift.

## `managedContainer` means something else in two plugins

`signalk-doctor` and `signalk-updater` also have a `managedContainer` option, but
it defaults to **false** and means _"a systemd Quadlet owns this local
container"_ — not _"the service is on another host"_. It is a name collision,
not a variant of this feature: those plugins have no remote endpoint, and
`AdoptedContainer` is what already models them. Do not wire them to
`resolveEndpoint`.

## A self-hosted upstream has to be resolved, not assumed

A consumer that hardcodes a container DNS name (`sk-<name>:<port>`) to reach a
peer will break when that peer is self-hosted — and, in fact, already breaks on
a bare-metal or shared-netns host, since signalk-container picks between
loopback and container DNS depending on the topology. Resolve peer addresses
rather than assuming one.
