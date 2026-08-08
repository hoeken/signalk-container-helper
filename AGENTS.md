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
| main  | `signalk-container-helper`    | Node    | none — zero-dependency, imports no Node builtins |
| UI    | `signalk-container-helper/ui` | browser | `react` (optional peer, `>=17`)                  |

The main entry importing **no Node builtins at all** is a property worth
preserving. It is what keeps the supported Node range wide and the dependency
surface empty. Check before adding an import.

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
pins the mirror against the real thing so it cannot silently drift. When a
`signalk-container` bump lands, that test passing is the evidence the mirror is
still correct — say so explicitly rather than assuming it.

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

### `test/` is compiled by a separate tsconfig

`tsconfig.json` covers `src/**` only. Test type errors surface via
`npm run typecheck:test` (`tsconfig.test.json`), which `npm test` runs first. A
type error in a test does not fail `npm run build`.

### The publish workflow parses CHANGELOG.md by exact heading

`publish.yml` extracts release notes with `awk` matching the literal heading
`# v<tag>`. Tag `v1.2.3` requires a heading of exactly `# v1.2.3` — no `##`, no
date suffix, no `v` omitted. A missing or misspelled section is a **hard failure**
of the release job.

Verify before tagging:

```bash
awk -v ver="# v0.3.0" '$0==ver{f=1;next} f&&/^# v/{exit} f{print}' CHANGELOG.md
```

Empty output means the release will fail.

### `npm run release` tags whatever is checked out

The script is `git tag v$npm_package_version && git push && git push origin <tag>`.
Run from a branch, it tags the branch head and pushes the branch. Tags must be
created on `main` after merge. Prefer tagging explicitly (see below) over running
this script.

## Release process

**Version bumps and tags are separate steps. Never mix a version bump into a
feature or fix PR.**

This matters because the bump commit is what the tag points at, and mixing makes
the release history unreadable — v0.3.0 in this repo is a cautionary example: its
bump rode inside a `feat:` PR and the tag landed on an unrelated `fix:` merge, so
nothing at the tag says "release". v0.2.2 shows the intended shape.

Publishing is **OIDC trusted publishing**. `publish.yml` grants `id-token: write`
and there is no `NPM_TOKEN` or `NODE_AUTH_TOKEN` anywhere in the workflows. Any
npm token in a local `~/.npmrc` is used for reads only and is **not** in the
release path. Published artifacts carry a SLSA provenance attestation; its
presence is how you confirm the OIDC path was used.

### Steps

1. **Land the work.** Feature and fix PRs carry no version bump.
2. **Open a release PR, on its own.** Branch `chore-release-<x>-<y>-<z>`:
   - `npm version <x.y.z> --no-git-tag-version` (bumps `package.json`; there is
     no committed lockfile to keep in step)
   - add the `# v<x.y.z>` CHANGELOG section
   - commit as `chore(release): <x.y.z>` — nothing else in the commit
3. **Verify before tagging**, on merged `main`:
   ```bash
   rm -rf node_modules package-lock.json && npm install
   npm run build && npm test && npm run ci-lint
   ```
4. **Tag the merge commit on `main`** and push:
   ```bash
   git checkout main && git pull --ff-only
   git tag v<x.y.z> <merge-sha> && git push origin v<x.y.z>
   ```
5. The tag push triggers `publish.yml`: GitHub Release from the CHANGELOG
   section, then `npm publish --provenance`.

### Choosing the number

Semver against **consumers**, not against the size of the diff:

- **patch** — dependency maintenance, docs, internal fixes with no API change
- **minor** — new API, or _widening_ a constraint. Lowering the Node floor is a
  minor: it takes nothing away but changes who can install.
- **major** — removing or narrowing anything a consumer depends on, including
  raising the Node floor or tightening a peer range

## Commit and PR conventions

Angular style, already consistent across this repo's history:

```
<type>(<optional scope>): <subject>
```

Types in use: `feat`, `fix`, `chore`, `docs`, `test`, `ci`, `refactor`. Scopes are
used sparingly — `chore(release):`, `chore(deps):`.

- Subject in imperative mood, lowercase, no trailing period.
- Body explains **why**, not what the diff already shows. The interesting content
  is the reasoning and the evidence.
- **PR titles follow the same convention** — they become the merge commit subject.
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
skips `chore(release):` and `chore(deps):` titles entirely; that is harmless for a
pure version bump, but it is another reason to keep release PRs mechanical (bump
plus changelog, nothing else) and put anything reviewable in its own PR.

## Claims and evidence

State only what was actually verified, and say which runtime or command produced
it. "96/96 tests pass on Node 22.22.0 and 24.14.0" is useful; "tests pass" is not.
If something was not run, say so rather than implying coverage.

For version-floor and compatibility claims specifically, grepping for an API is
weak evidence. Type-checking against the types of the _lowest_ supported version
is strong evidence — that is why `@types/node` is pinned to the floor (`^22`) and
not to the latest.
