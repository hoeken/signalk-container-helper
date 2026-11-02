# Contributing

Thanks for helping. **[AGENTS.md](AGENTS.md) is the guide for everyone who
changes this repository**, people and AI agents alike. It is the single source
of truth, so this file only names what you meet first.

## Strict TypeScript only

This is a strict TypeScript project:

- Every source file is TypeScript: the library in `src/`, the tests in
  `test/`, and the tooling configs at the root (`eslint.config.ts`,
  `vitest.config.ts`). Do not add JavaScript (`.js`, `.mjs`, `.cjs`, `.jsx`);
  `npm run ci-lint`, and so CI, fails on it.
- `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride` in
  `tsconfig.json` are a floor. Do not relax them anywhere.
- `any` is a lint error; use `unknown` and narrow it. No `@ts-ignore` or
  `@ts-nocheck`. Fix a type rather than loosening it to make something compile.

The details and the reasons are in
[AGENTS.md → Strict TypeScript only](AGENTS.md#strict-typescript-only).

## Before you open a pull request

```bash
npm install       # there is no committed lockfile
npm run build
npm test          # type-checks src, test and the root configs, then runs vitest
npm run ci-lint   # eslint (type-checked) and prettier
```

- Title the pull request in Angular style, such as
  `fix(util): walk error cause chains in errMsg`. The title becomes the
  release-notes line.
- Do not bump the version: release-please opens the release pull request.

Everything else, from the release process to the code review, is in
[AGENTS.md](AGENTS.md).
