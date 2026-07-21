# Plan: single global install (`npm install -g rbo-cli` → `rbo ...`)

Status: **plan only, not implemented.** This document analyzes what changes today's architecture
actually needs to reach a Fusion-style install UX (`npm install -g <pkg>`, then `rbo ...` for
everything), and proposes a phased path there. Nothing here should be read as already working.

## Current state vs. the target

Today, `rbo` (the `@rbo/cli` workspace package) is a **thin client**: it talks to an already-
running Controller over loopback HTTP. The Controller and Agent are separate processes you start
by directly invoking their own built entry points (`node apps/controller/dist/main.js`, `node
apps/agent/dist/main.js`), each with their own `package.json` and workspace dependencies
(`better-sqlite3`, `ws`, `selfsigned`, etc.), currently linked via pnpm's `workspace:*` protocol —
which only resolves inside this monorepo, not from a published npm package.

The target: `npm install -g rbo-cli` (name TBD — see Open questions), then `rbo controller start`,
`rbo agent start`, `rbo submit ...` all work from one globally-installed package, with no separate
archive to extract and no monorepo checkout required.

## What actually blocks this today

1. **Controller/Agent aren't CLI subcommands.** `apps/controller/src/main.ts` and
   `apps/agent/src/main.ts` are independent entry points, not functions the CLI's `main.ts` can
   call. Needs: extract each into an exported `runController(options)` / `runAgent(options)`
   function the CLI can import and invoke under `rbo controller start` / `rbo agent start`
   subcommands, with a foreground mode (current behavior) and a real daemonized mode (detached
   process + PID file + redirected log file — today's Controller only runs in the foreground).

2. **Five internal `@rbo/*` packages aren't publishable as-is.** `workspace:*` version specifiers
   only resolve inside this pnpm workspace. A published `rbo-cli` package needs everything it
   depends on (`@rbo/protocol`, `@rbo/shared`, `@rbo/snapshot`, `@rbo/executor`, plus the
   Controller/Agent/mcp-stdio logic) available at install time. Two real options:
   - **(a) Publish all workspace packages to the npm registry** under a real scope, with pinned
     (not `workspace:*`) version ranges. Simplest conceptually, but means versioning and publishing
     6+ packages in lockstep on every release.
   - **(b) Bundle.** Use a bundler (esbuild is already implicitly compatible with this repo's
     ESM/TS setup) to produce one self-contained `dist/rbo.cjs` (or `.mjs`) per published artifact,
     inlining every `@rbo/*` workspace import and leaving only genuinely external npm packages
     (`ws`, `better-sqlite3`, `selfsigned`, `ulid`, `zod`, `@modelcontextprotocol/sdk`) as real
     `dependencies` of the published package. Recommended — one package to publish, no lockstep
     versioning problem, and it's the pattern most CLI tools with an internal monorepo use.

3. **`better-sqlite3` is a native module.** It needs a prebuilt binary per Node ABI/OS/arch at
   install time. This already works via pnpm in this repo; confirm the same prebuild-fetch path
   works under plain `npm install -g` (it should, via `node-gyp-build`/`prebuildify`'s standard
   resolution) — call this out explicitly as a thing to verify, not assume.

4. **The Windows Job Object helper is a compiled Rust binary, not JS.** `npm install -g` can't
   compile it in place (no guarantee of a Rust toolchain on the install machine) or the current
   packaging model doesn't cross-compile for a package published from one CI runner. Options,
   roughly in order of effort: (a) ship a per-platform optional dependency package containing a
   prebuilt binary for each supported OS/arch (the pattern `esbuild`/`swc` use — `rbo-cli` depends
   on `optionalDependencies: { "rbo-windows-executor-win32-x64": "..." }` etc., built and published
   from CI); (b) a postinstall script that downloads the correct prebuilt binary from a GitHub
   Release for the detected platform, with a documented offline/air-gapped fallback. Needs a CI
   pipeline change (build the release binary once per tag, upload it, whichever mechanism is
   chosen) — out of scope for a docs-only pass.

5. **Package identity.** `@rbo/cli`'s current npm scope (`@rbo`) may or may not be available/owned
   on the public registry — this needs an actual registry check before picking a final published
   name (e.g. `rbo-cli`, `@yourorg/rbo`, etc.); don't assume `@rbo` is free.

## Phased plan

1. **Extract `runController`/`runAgent` as callable functions**, keep the existing standalone
   entry points as thin wrappers around them (`main.ts` calls `runController(loadControllerConfig())`
   then handles process signals) so nothing regresses for the current from-source workflow. Add
   `rbo controller start`/`rbo agent start` subcommands that call these directly, with a
   `--daemon` flag for detached/PID-file/log-redirected operation (foreground stays the default,
   matching current documented behavior).
2. **Prototype the esbuild bundle** for `apps/cli` alone first (smallest surface), producing one
   file with `@rbo/protocol`/`@rbo/shared` inlined; verify `pnpm pack` → local `npm install -g
   ./rbo-cli-0.1.0.tgz` → `rbo doctor` actually works from a machine outside this monorepo/pnpm
   context.
3. **Extend the bundle to include Controller + Agent** (using the extracted functions from step 1)
   in the same published package, keeping `better-sqlite3`/`ws`/etc. as real external deps of the
   published package (not bundled — native modules can't be bundled).
4. **Solve the Windows Job Object binary distribution** (pick one of the options in point 4 above)
   — do this only once steps 1–3 prove the JS side works end to end, since it's the highest-effort,
   most platform-specific piece.
5. **Publish an actual test release** to a real (or a scoped/private) registry and validate the
   whole `npm install -g` → `rbo controller start` → `rbo agent start` → pair → `rbo submit` flow
   on a clean machine with none of this repo's toolchain installed — the real acceptance bar, not
   "it builds."
6. Update `README.md`'s Install section and `docs/ops/getting-started.md` to lead with the new
   global-install path once step 5 is verified; keep the archive/from-source paths as the
   documented fallback for restricted/offline environments.

## Open questions (need a decision, not guesses)

- Final published package name/scope (see point 5 above — needs an actual registry check).
- Daemon strategy per OS for `--daemon` mode (a real Windows Service/launchd/systemd install is
  already dry-run-only today per `docs/ops/runbook.md`; decide whether `--daemon` targets that
  same mechanism or a simpler detached-process model as a first step).
- Whether Controller and Agent ship in the *same* published package (simplest for users, larger
  install) or as separate optional packages (`rbo-cli` + `rbo-agent`) a user opts into per machine
  role.
