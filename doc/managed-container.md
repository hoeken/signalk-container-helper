# ManagedContainer

## What `start()` does

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

## Cancelling an operation

`start()` and `applyUpdate()` take an optional second argument carrying an
`AbortSignal` (for `applyUpdate()` also `pull`, below, and `ifTag`, under
[Updating the image after a plugin update](#updating-the-image-after-a-plugin-update)):

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

Updates queue among themselves and apply in the order they were called, but
take the lifecycle lock only for the recreate, after their pull. A `start()`
or `stop()` cancels every update called before it: one still pulling is not
waited for, and once its pull ends it rejects as `cancelled` without
recreating. An update called while the instance is stopped, after `stop()` or
before any `start()`, rejects the same way. signalk-server mounts plugin
routes whether the plugin runs or not, and restarts a plugin on a config save
only once its `stop()` resolved, so without this a long pull would hold up
the restart, and then recreate the container for a run that is gone.

## Pulling on an update

`recreate()` pulls only an image missing from the host, so `applyUpdate()`
moves a container to a newer image of the tag it already runs, such as
`latest`, only with `{ pull: true }`. `registerUpdateRoutes` passes it; an
"Update now" route of your own should too. Leave it off for a recreate that is
not an update, such as after a device was plugged in, so that one pulls only
an image the host lacks. (Before signalk-container 1.12.0, `applyUpdate()`
always pulls.)

With `pull: true`:

- a config pinned to a digest is not pulled;
- a failed pull recreates on the host's image of the tag where that is
  another image than the container runs (by image id) or no container is
  listed, as on a rollback while offline or after an update check already
  pulled the new image; otherwise it rejects with `pull-failed` and leaves the
  container as it was;
- the pull runs before the update takes the lifecycle lock, so a `stop()`
  meanwhile does not wait for the download; the update then stands down
  without recreating. A recreate that pulls a missing image still runs under
  the lock.

## Retrying forever

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
down when `stop()` runs, or once `applyUpdate()` has recreated the container,
instead of restarting the container on the image the operator just moved away
from. An update that fails before its recreate, as on a pull while offline,
leaves the loop retrying.

`retryForever` is exported on its own for the same policy applied to work this
library does not manage — an external service a plugin points at but does not
own, for instance.

## Updating the image after a plugin update

signalk-container moves a container to a newer image of its tag only where
the config sets `autoUpdateOnFloatingTag`. Its update checks may pull the tag
to compare digests, but the container stays on the image it runs, so a
container on a floating tag such as `latest` stays on whatever release the
first install pulled. `updateImageAfterPluginUpdate` closes that gap at the
moment an operator expects change anyway: the first start after your plugin
itself was updated, or its first start at all.

```ts
let abort: AbortController | undefined;

// in start(), once `await container.start()` resolved — not awaited:
abort = new AbortController();
void updateImageAfterPluginUpdate({
  manager,
  pluginVersion, // from your package.json
  stateFile: path.join(app.getDataDirPath(), "image-check.json"), // one per container
  tag: settings.imageTag,
  versionSource: { githubReleases: "questdb/questdb" },
  currentVersion: () => queryRunningVersion(), // "9.4.3", or null
  update: (signal) => yourUpdate(signal), // see below
  signal: abort.signal,
})
  .then((outcome) => app.debug(`image check after plugin update: ${outcome}`))
  .catch((err) => app.error(`image check after plugin update: ${errMsg(err)}`));

// in stop():
abort?.abort();
```

It checks once per plugin version, and only a tag signalk-container
classifies as floating; one that names a single release, such as `9.4.3`,
stays as it is. Before it downloads anything, it asks signalk-container
whether [signalk-internet](https://github.com/meri-imperiumi/signalk-internet)
reports a free link, waiting up to `linkWaitMs` (default 60 s) for its first
state after a restart; without signalk-internet enabled the link counts as
free (signalk-container 1.38.0+; an older one cannot tell, and the check ends
as `link-restricted`). On a metered, offline or captive link, or where the
running or the latest version cannot be read, it asks again every
`linkRetryMs` (default 15 min), until it can go on or the signal aborts. The
promise can therefore stay pending for as long as the plugin runs, which is
why `signal` is required.

Where `update()` resolves false, it records nothing, so the next start checks
again. Once `update()` has applied an update it records the version, then
waits up to `versionWaitMs` (default 2 min) for the recreated container to
report the latest release or a later one. A container that then still reports
an older release, or none, ends as `behind-after-update`, as on a bare-major
tag such as `9` while the latest is `10.1.0`: checking again would recreate
the container at every start.

`update()` is yours because the recreate has to run under your plugin's own
lifecycle lock. It has to pull the tag before the recreate: `recreate()` alone
does not pull an image that is already on the host. Resolve true once the
container was recreated, even where a later step of your own failed, and false
(or throw) where it was not; neither records anything, so the next start
checks again. With a `ManagedContainer`, `applyUpdate()` with `pull: true`
does both under its own lock, and `ifTag` keeps it from undoing an operator's
choice:

```ts
async function yourUpdate(signal: AbortSignal): Promise<boolean> {
  try {
    // ifTag: the tag was read at start, and the check may have waited days
    // for a free link. Where "Update now" moved the container meanwhile, this
    // rejects with tag-mismatch and leaves it where the operator put it.
    await container.applyUpdate(tag, { pull: true, ifTag: tag, signal });
    return true;
  } catch (err) {
    const expected =
      err instanceof ContainerHelperError &&
      (err.code === "cancelled" || err.code === "tag-mismatch");
    if (!expected) app.error(`image update: ${errMsg(err)}`);
    // Not recorded, so the next start checks again. A recreate that failed
    // after it removed the container needs no repeat: that start brings the
    // container back on the tag, now pulled, and the check finds it current.
    return false;
  }
}
```

The check reads `tag` once, and `app.savePluginOptions` does not restart the
plugin, so an "Update now" that pins another release while the check waits
does not end it. Without `ifTag`, the check would then pull `latest` and move
the container back to the release the operator rolled back from. With it, the
update rejects with `tag-mismatch`, the check ends as `not-applied` and records
nothing, and the next start reads the pinned tag and ends as
`tag-not-floating`.

`ifTag` is compared with the tag as requested from `start()` or the last
update, before `resolveTag` maps it, so a pin on the very release a floating
alias maps to still counts as a move. Updates run one at a time in call
order, and the comparison is made when the update's turn comes, so it also
holds where the operator's update was queued ahead of the check's. While a
start or update may be changing the container, and after one failed before
the container was up on its tag, the tag is not known and matches no
`ifTag`: an "Update now" that replaced the container and then failed is not
undone either. A start that brought the container up but never saw the app
ready (`not-ready`) leaves the tag known.
