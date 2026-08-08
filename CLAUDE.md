# CLAUDE.md

See **[AGENTS.md](AGENTS.md)** — it is the single source of truth for how to work
in this repo, and it applies in full to Claude Code. Read it before making
changes.

Do not add guidance here. Put it in `AGENTS.md` so every agent and human
contributor reads the same document, and this pointer cannot drift out of sync
with it.

Two things are worth knowing before you run anything, because both do damage
silently:

- **`package-lock.json` is not committed** — install with plain `npm install`.
- **Never mix a version bump into a feature or fix PR.**

`AGENTS.md` explains why, and covers the rest.
