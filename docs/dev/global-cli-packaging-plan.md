# Plan: single global install (`npm install -g @gemslibe/rbo` → `rbo ...`)

Status: **plan only, not implemented.** This document analyzes what changes today's architecture
actually needs to reach a Fusion-style install UX (`npm install -g <pkg>`, then `rbo ...` for
everything), and proposes a phased path there. Nothing here should be read as already working.

This is the **first** public distribution of RBO. Do **not** add migration shims for today's
ad-hoc default paths (`%LOCALAPPDATA%/RBO`, `%ProgramData%/RBO`, `~/.rbo-agent`, etc.) — replace
them with the layout below in one clean cut (same rule as `AGENTS.md`: no migration shims).

## Decisions (locked)

| Topic | Decision |
| --- | --- |
| Published package | `@gemslibe/rbo` (npm org `gemslibe`) |
| Publish root in monorepo | **`apps/cli`** becomes the publish package (`"name": "@gemslibe/rbo"`); replace today's `@rbo/cli` name. Other workspace packages stay `@rbo/*` and are **not** published |
| Bins / bundle shape | Two esbuild entry points: `dist/rbo.js` + `dist/rbo-mcp-stdio.js`; `bin`: `rbo` and `rbo-mcp-stdio` |
| Internal packages | **Bundle** workspace `@rbo/*` (and controller/agent/mcp-stdio) into those artifacts; leave genuine npm externals as `dependencies` |
| Package contents | **One package** ships CLI + Controller + Agent + mcp-stdio |
| Background mode | `--daemon` = **detached process** only (PID file + log redirect) |
| OS service install | **Deferred** for this effort: leave `rbo agent install|--execute` as today's dry-run/placeholder paths; do not block npm v1 on wiring services to the global `rbo` bin |
| Windows Job Object binary | `optionalDependencies` → `@gemslibe/rbo-windows-executor-win32-x64` (esbuild/swc-style). Built and published alongside the main package |
| Windows arches (v1) | **win32-x64 only**; other Windows arches run without the helper (same class of limitation as macOS/Linux today); `rbo doctor` must warn |
| Versioning | **Single product semver**: `@gemslibe/rbo@x.y.z` matches all runtime version constants and the windows-executor optional package. Update `docs/dev/release-builds.md` (today it still allows independent controller/agent bumps) |
| Data/config root | Single tree: `~/.rbo/` on Unix; `%USERPROFILE%\.rbo\` on Windows |
| Layout under that root | Controller under `~/.rbo/` (exact subdirs TBD). **Agent under `~/.rbo/agent/`** |
| Path overrides | If unset: controller `~/.rbo`, agent `~/.rbo/agent`. If `RBO_DATA_DIR=X`: controller `X`, agent `X/agent`. If `RBO_AGENT_STATE_DIR=Y`: agent `Y` (always wins over the derived path). CLI flags may override the same way |
| First run | **Explicit init**: extend existing `rbo controller init`; add `rbo agent init`. `start` fails with a clear hint if init was not done |
| Distribution channels | **npm is primary**; OS archives remain the offline/air-gap fallback at the same semver. Archives should ship the **same bundled bits** (plus platform notes), not a divergent multi-entry layout that drifts from npm |
| First registry publish | **Public** (`npm publish --access public`) on the first tagged release |
| Who publishes (v1) | **Manual** publish from a maintainer machine. The windows-executor optional package requires a **Windows-built** `rbo-windows-executor.exe` (build on Windows, then publish both packages in one checklist). CI automation can come later |
| License | **MIT** (`LICENSE` + `"license": "MIT"` on the published package) |
| Acceptance before first public | Full clean-machine E2E required on **Windows x64** only; other OS best-effort / follow-up with honest release-note limitations |

## Current state vs. the target

Today, `rbo` lives in `apps/cli` as workspace package `@rbo/cli` (will be renamed to
`@gemslibe/rbo` for publish). It is mostly a **thin client**: it talks to an already-running
Controller over loopback HTTP. `rbo controller init|fingerprint|restore` already exist; there is
**no** `rbo controller start` / `rbo agent start` / `rbo agent init`. Controller and Agent still
start via their own entry points (`node apps/controller/dist/main.js`,
`node apps/agent/dist/main.js`), each with workspace dependencies linked via pnpm `workspace:*` —
which only resolves inside this monorepo.

Default paths today are inconsistent across components (CLI/controller often
`%LOCALAPPDATA%/RBO` or `~/.rbo`; agent often `~/.rbo-agent` or OS-specific ProgramData/Library
paths). v1 replaces all of that with the single `~/.rbo/` tree above.

The target: `npm install -g @gemslibe/rbo`, then `rbo controller init` / `rbo agent init`,
`rbo controller start`, `rbo agent start`, `rbo submit ...`, and MCP via `rbo-mcp-stdio`, all from
one globally-installed package — no archive extract and no monorepo checkout required for the
happy path.

## What actually blocks this today

1. **Controller/Agent aren't startable as CLI subcommands.** Extract
   `runController(options)` / `runAgent(options)`; keep standalone `main.ts` as thin wrappers for
   from-source. Add `rbo controller start` / `rbo agent start` (foreground default; `--daemon` =
   detached + PID + log). Extend `rbo controller init`; add `rbo agent init` that scaffolds
   `~/.rbo/agent/`. Refuse `start` if the relevant init has not been done.

2. **Internal `@rbo/*` packages aren't publishable as-is.** `workspace:*` only resolves inside
   this pnpm workspace. **Decision: bundle** with esbuild (or equivalent) into `@gemslibe/rbo`,
   inlining workspace imports and leaving genuine externals (`ws`, `better-sqlite3`, `selfsigned`,
   `ulid`, `zod`, `@modelcontextprotocol/sdk`, …) as real `dependencies`.

3. **`better-sqlite3` is a native module.** Confirm prebuild fetch works under plain
   `npm install -g` (do not assume). Keep it external — do not bundle.

4. **Windows Job Object helper is a compiled Rust binary.** **Decision: optionalDependency**
   `@gemslibe/rbo-windows-executor-win32-x64`. Runtime resolves the exe from that package's install
   path (not only the old `packaging/*/MANIFEST` layout).

5. **Package identity — decided.** Publish from `apps/cli` as `@gemslibe/rbo`. Other workspace
   packages remain private `@rbo/*` and are inlined by the bundle.

## Phased plan

1. **Unify defaults + lifecycle CLI.** Point controller/CLI/agent defaults at `~/.rbo/` and
   `~/.rbo/agent/`. Extract `runController`/`runAgent`; add `start` (+ `--daemon`) and `agent init`;
   make `start` require prior init. Keep from-source `main.ts` wrappers.
2. **Rename `apps/cli` → `@gemslibe/rbo`** and prototype esbuild for the CLI entry
   (`dist/rbo.js`); verify `pnpm pack` → `npm install -g ./gemslibe-rbo-0.1.0.tgz` → `rbo doctor`
   outside this monorepo.
3. **Extend the bundle** to Controller + Agent + second entry `dist/rbo-mcp-stdio.js`; wire both
   `bin`s. One product semver across published `package.json` and `packages/shared` version
   constants. Add MIT `LICENSE`.
4. **Ship `@gemslibe/rbo-windows-executor-win32-x64`**; wire path resolution + `doctor` warnings
   when missing.
5. **Manual public publish** (Windows host for the exe + both npm publishes). Clean **Windows x64**
   E2E: `npm install -g @gemslibe/rbo` → inits → start → pair → submit. That is the acceptance bar.
6. **Docs:** README + `getting-started.md` lead with global install; archives as offline fallback
   (same bundled bits). `release-builds.md`: single-semver rule + manual npm publish checklist
   (including “build exe on Windows before publishing the optional package”).

## Implementation notes (not open product questions)

- Declare `"engines": { "node": ">=22.14" }` on `@gemslibe/rbo`; surface mismatches in `rbo doctor`.
- Fix an allowlist of externals that must never be bundled (at least `better-sqlite3` and other
  native/CJS-sensitive deps).
- Concrete subdirs under `~/.rbo/` (e.g. logs, pid files) are an implementation detail; agent
  state must live under `~/.rbo/agent/` (or `$RBO_DATA_DIR/agent` per the override table).
- When `stateDir` is `~/.rbo/agent`, existing “sibling of stateDir” helpers (e.g. repo-cache) will
  naturally land under `~/.rbo/` — confirm that in implementation, no separate product decision.
- OS service → global `rbo` bin is a follow-up; not part of the npm v1 acceptance bar.
- Automating publish via CI is deferred; v1 is maintainer-driven publish.
