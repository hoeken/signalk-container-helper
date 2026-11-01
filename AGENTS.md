# AGENTS.md

Working notes for AI agents and human contributors. `CLAUDE.md` points here; this
file is the single source of truth.

## What this is

A typed, zero-dependency helper library for Signal K plugins that manage
containers through the [signalk-container](https://github.com/dirkwa/signalk-container)
plugin. It is a **library**, not an application — every constraint declared here
is inherited by every consuming plugin, so widening or tightening one is a
user-facing decision, not an implementation detail.

Two entry points, deliberately separated:

| Entry | Import                        | Runtime | Dependencies                                     |
| ----- | ----------------------------- | ------- | ------------------------------------------------ |
| main  | `signalk-container-helper`    | Node    | none — zero-dependency, one Node builtin (below) |
| UI    | `signalk-container-helper/ui` | browser | `react` (optional peer, `>=17`)                  |

The main entry imports **one Node builtin**, `node:async_hooks`, and only in
`device-watch.ts`: `watchHostDevice`'s `stop()` needs `AsyncLocalStorage` to
tell its own handler from any other caller, which nothing else can.
`AsyncLocalStorage` is stable in every Node the `engines` floor allows; its
`disable()`, which sheds Node 22's per-promise tracking cost between events,
is still marked experimental (it has existed since Node 13.10). Keeping the list that
short is what keeps the supported Node range wide and the dependency surface
empty. Check before adding another, and never import one from a module the UI
entry also loads.

## Layout

```
src/            library source (ESM, .js extensions in relative imports)
  index.ts      main entry — Node side
  types.ts      type mirror of signalk-container's public API
  ui/           browser entry — React building blocks
    components.tsx  the only .tsx in the repo; everything else is .ts
test/           vitest suites + types-contract.test-d.ts
```

The UI source **does** use JSX (`components.tsx`, `tsconfig` sets
`"jsx": "react"`), but `tsc` emits plain `React.createElement` calls — verified:
zero raw JSX in `dist/`. That emitted shape is what lets consumer webpack builds
that exclude `node_modules` from babel-loader bundle the shipped `dist/`
directly. The "no JSX" property README refers to is about the **artifact**, not
the source; do not add a JSX transform expectation for consumers.

`src/types.ts` mirrors `signalk-container`'s API. `test/types-contract.test-d.ts`
pins the mirror's **shape** — structural equality and name coverage — so a
changed signature or a dropped member fails compilation. When a
`signalk-container` bump lands, that test passing is the evidence the _shapes_
are still right; say so explicitly rather than claiming more.

**It does not check JSDoc, and prose is where the mirror actually broke.**
Issue #35: our `signalkDataMount` doc said "the plugin's data dir", which in a
file addressing consumer-plugin authors reads as the consumer's. It is
signalk-container's own. The contract test stayed green throughout.

That was not upstream drift — it was lossy compression. Upstream states the
fact plainly, but in the _neighbouring_ field's block (`signalkConfigRootMount`
explains what `signalkDataMount` resolves to), and the mirror dropped the
clause when condensing two blocks into one. So when mirroring:

- If a member's behaviour depends on **which plugin's `app` object** resolves
  it, name the owner explicitly. "signalk-container's own", never "the
  plugin's". `signalkDataMount`, `resolveSignalkDataMount`,
  `signalkConfigRootMount`, and `removeManagedData` are all in this class.
- Before condensing a block, grep the canonical `.d.ts` for the member's name
  and read every hit **outside** its own JSDoc. Disambiguation living next
  door is exactly what gets lost.
- Keep behavioural facts (what throws, what is refused) even when trimming
  prose. Those are contract, not flavour.

`test/types-doc-anchors.test.ts` pins these claims for the known-dangerous
members. It is a tripwire against re-simplification, not a general guard — it
has no power over a member nobody has audited yet.

## Commands

```bash
npm install       # no committed lockfile; see the note under Traps
npm run build     # tsc
npm test          # typecheck:test && vitest run
npm run ci-lint   # eslint && prettier --check .
npm run format    # prettier --write && eslint --fix
```

Run **all three** of build, test, and ci-lint before pushing. CI runs the same
three on a `["22", "24"]` matrix; there is no reason to discover a failure there
that a local run would have caught.

## Traps

These have each cost a real debugging session. They are not hypothetical.

### `package-lock.json` is not committed — install with plain `npm install`

Locally, just run `npm install`. There is no committed lockfile to keep in sync,
and nothing to remember.

This is deliberate. npm **ignores a dependency's lockfile entirely** — consumers
of a library resolve against their own tree — so committing one here bought
nothing downstream while creating a drift class that only failed at release time.
The v0.3.0 release shipped a lockfile with the right version number and the wrong
`@types/node` for exactly this reason: a `~/.npmrc` containing
`package-lock=false` (this maintainer's does) makes `npm install` skip the
lockfile write, and `npm version` rewrites only the version fields, so a bump
looks complete while a dependency change from the same session is missing.

Removing the committed lockfile removes that whole failure mode. Both workflows
now generate one per run and install from it:

```yaml
npm install --package-lock-only
npm ci
```

That keeps each CI run internally reproducible while resolving fresh every time —
the same pattern `signalk-server` uses. The trade is real and worth knowing: a
transitive dependency can now break CI without any change on our side. That is
acceptable for a zero-runtime-dependency library whose lockfile no consumer ever
sees; it would not be for an application.

### `src/url.ts` must use the `URL` global, never `node:url`

`normalizeExternalUrl` is imported by **both** entries — the Node side via
`endpoint.ts` and the browser side via `ManagedModeFields`. Writing
`import { URL } from "node:url"` compiles, passes every test, and silently
breaks two invariants at once: the main entry's short list of Node builtins,
and the UI bundle for every consumer whose webpack config does not
polyfill Node core. `URL` is a global in both runtimes; just use it.

### `test/` is compiled by a separate tsconfig

`tsconfig.json` covers `src/**` only. Test type errors surface via
`npm run typecheck:test` (`tsconfig.test.json`), which `npm test` runs first. A
type error in a test does not fail `npm run build`.

### Release notes are generated from merged PR titles

There is no CHANGELOG.md. release-please creates each GitHub Release with
`changelog-type: github`, so the notes for a tag are GitHub's own list of the
PRs merged since the previous tag, grouped into sections by `.github/release.yml`
(which maps labels → headings, with `"*"` catching the unlabelled).

Two consequences worth internalising:

- **A PR title is user-facing copy.** It is what appears in the release notes,
  so it has to read as a change description on its own — see
  [Commit and PR titles](#commit-and-pr-titles).
- **Labels choose the section, and the title chooses the label.**
  `label-by-title.yml` labels every PR from its title's type when it is opened
  or retitled: `feat`/`perf` → `enhancement`, `fix` → `bug`, `docs` →
  `documentation`, and `ci`/`test`/`chore`/`refactor`/`style` and
  `build(deps-dev)` → `skip-changelog`, which leaves the PR out of the notes. A
  type it does not map lands under "Other". After relabelling a merged PR by
  hand, run release-please from the Actions tab to regroup the open release PR.

## Release process

Releases are made by [release-please](https://github.com/googleapis/release-please).
**Never bump the version, push a release tag, or run `npm publish` by hand**, and
never mix a version bump into a feature or fix PR. v0.3.0 in this repo shows why
the bump must stand alone: its bump rode inside a `feat:` PR and the tag landed
on an unrelated `fix:` merge, so nothing at the tag says "release".

Publishing is **OIDC trusted publishing**. `publish.yml` grants `id-token: write`
and there is no `NPM_TOKEN` or `NODE_AUTH_TOKEN` anywhere in the workflows. Any
npm token in a local `~/.npmrc` is used for reads only and is **not** in the
release path. Published artifacts carry a SLSA provenance attestation; its
presence is how you confirm the OIDC path was used.

### Steps

1. **Land the work** through PRs with conventional titles. A merge that carries
   a releasable change (below) makes `release-please.yml` open or refresh the
   release PR: `chore(release): <x.y.z>`, bumping `package.json` and
   `.release-please-manifest.json` and nothing else.
2. **Merge the release PR when you want to release.** It shows no CI checks: a
   PR opened with `GITHUB_TOKEN` starts no workflow. It changes only the
   version, and every change in it already passed CI on `main`.
3. The merge makes release-please tag the merge commit `v<x.y.z>` and create the
   GitHub Release, then dispatch `publish.yml` on the tag, which runs
   `npm publish --provenance` (`prepublishOnly` builds and tests first).

The dispatch is needed because a tag pushed with `GITHUB_TOKEN` starts no
workflow, silently. `publish.yml` must stay the file that publishes: npm's
trusted publishing is bound to its file name. If a publish fails after the tag
exists, re-run `publish.yml` from the Actions tab with the tag as the ref.

release-please needs the repository setting **Settings → Actions → General →
"Allow GitHub Actions to create and approve pull requests"**; without it, it
cannot open the release PR.

### What counts as releasable

GitHub's generated notes are never empty, so release-please on its own would
open a release PR after every merge. The `gate` job in `release-please.yml` lets
a push through only when one of its commits is `feat`, `fix`, `perf` or
`revert`, is marked `!` or carries a `BREAKING CHANGE:` footer, is a runtime
dependency bump (`build(deps):`), carries a `Release-As:` footer, or is the
release PR's own merge. A `docs`, `ci`, `test`, `chore`, `refactor` or
`build(deps-dev)` merge waits for the next release. The gate's last alternative
is `pull-request-title-pattern` in `release-please-config.json`; change the two
together, or the release PR's merge is judged non-releasable and no tag is ever
created.

### Choosing the number

release-please derives the number from the commit types since the last tag:
`fix` → patch, `feat` → minor, and a breaking change → minor while the version
is `0.x` (`bump-minor-pre-major`; a `^0.y` range already treats a minor as
breaking). So the number is chosen by typing each change correctly, semver
against **consumers**, not against the size of the diff:

- **`fix`** — internal fixes with no API change (a runtime `build(deps)` bump
  is a patch too)
- **`feat`** — new API, or _widening_ a constraint. Lowering the Node floor is a
  `feat`: it takes nothing away but changes who can install.
- **`!` / `BREAKING CHANGE:`** — removing or narrowing anything a consumer
  depends on, including raising the Node floor or tightening a peer range

To set the number explicitly (1.0.0 is one), merge a commit with a
`Release-As: <x.y.z>` footer.

### Pre-releases

A pre-release is the one tag still pushed by hand: tag `v<x.y.z>-beta.<n>` (or
`-alpha.<n>`, `-rc.<n>`) on `main` and push it. `publish.yml` creates its GitHub
Release, sets the tag's version in `package.json` for that publish only (nothing
is committed, so `main` keeps the last release's version), and publishes under
the matching npm dist-tag. release-please does not track pre-release tags; the
next release PR still proposes `<x.y.z>`.

## Commit and PR titles

Angular style, required for **both commit subjects and PR titles**, and already
consistent across this repo's history:

```
<type>(<optional scope>): <subject>
```

Types in use: `feat`, `fix`, `chore`, `docs`, `test`, `ci`, `refactor`, `build`.
Scopes are used sparingly — `chore(release):`, `build(deps):`, `fix(util):`,
`feat(retry):`. Dependabot titles its bumps `build(deps)` (runtime),
`build(deps-dev)` (development) and `ci(deps)` (GitHub Actions); the release
gate and the labels read that prefix, so keep it on a bump raised by hand.

**A PR title is published copy.** Release notes are generated from the titles of
the PRs merged since the previous tag, so the title is what a consumer reads when
deciding whether to upgrade — not an internal label. Write it as a standalone
description of the change:

```
feat(retry): add retryForever and ManagedContainer readinessRetry
fix(util): walk error cause chains in errMsg
```

not `fix stuff`, `address review`, or `WIP`.

- Subject in imperative mood, lowercase, no trailing period.
- Body explains **why**, not what the diff already shows. The interesting content
  is the reasoning and the evidence.
- The type picks the PR's label, and the label its section in the notes (see
  [Release notes](#release-notes-are-generated-from-merged-pr-titles)).
- Branches use **hyphens, not slashes**: `chore-release-0-2-2`,
  `fix-lockfile-types-node-drift`. (Dependabot's slashed branches are the one
  exception and are not a precedent.)
- No `Co-Authored-By` trailers.

### Code review

The CodeRabbit **GitHub app is not installed on this repo**, so no PR gets an
automated review comment regardless of its title. Review happens locally via the
CLI, against the free allowance:

```bash
cr review --agent --base main
```

Two things follow. First, run that yourself before pushing — nothing on GitHub
will do it for you. Second, if the app is ever installed, note that CodeRabbit
skips `chore(release):` titles entirely; that is harmless for release-please's
version-only release PR, but it is another reason never to add anything to that
PR: put anything reviewable in its own PR.

## Claims and evidence

State only what was actually verified, and say which runtime or command produced
it. "96/96 tests pass on Node 22.22.0 and 24.14.0" is useful; "tests pass" is not.
If something was not run, say so rather than implying coverage.

For version-floor and compatibility claims specifically, grepping for an API is
weak evidence. Type-checking against the types of the _lowest_ supported version
is strong evidence — that is why `@types/node` is pinned to the floor (`^22`) and
not to the latest.
