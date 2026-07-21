# Building an RBO release (developer guide)

Audience: someone building and packaging RBO itself from source — not an operator installing an
already-built package (that's [`docs/ops/getting-started.md`](../ops/getting-started.md)).

## Prerequisites

- Node.js ≥ 22.14 (`.nvmrc`), pnpm 10.5.2 (pinned via `packageManager` in `package.json`)
- Rust 1.93.0 (`rust-toolchain.toml`) — only needed to produce the Windows Job Object helper
  (`rbo-windows-executor.exe`); build on Windows to get a real binary. macOS/Linux packages ship
  without it (§15.2 containment is Windows-only today; see Known limitations).
- Git on `PATH`

## One-time setup

```bash
git clone <this repo>
cd rm-builder
pnpm install
```

## Version numbers

All version constants live in one place: `packages/shared/src/versions.ts`.

```ts
export const RBO_CONTROLLER_VERSION = '0.1.0';
export const RBO_AGENT_VERSION = '0.1.0';
export const RBO_STDIO_ADAPTER_VERSION = '0.1.0';

export const RBO_WIRE_PROTOCOL_MIN_VERSION = 1;
export const RBO_WIRE_PROTOCOL_MAX_VERSION = 1;

export const RBO_CONTROLLER_SCHEMA_VERSION = 3; // must equal MIGRATIONS.length — guarded by a test
```

- `RBO_CONTROLLER_VERSION` / `RBO_AGENT_VERSION` / `RBO_STDIO_ADAPTER_VERSION`: bump per release.
  They're independent — the Controller, Agent, and stdio adapter don't need to move in lockstep.
- `RBO_WIRE_PROTOCOL_MIN_VERSION` / `MAX_VERSION`: bump **only** when the actual wire contract
  changes (new/changed message schema an old peer can't parse). Per `AGENTS.md`'s no-migration-shim
  rule, don't add compatibility shims — an incompatible peer stays diagnostic-only by design.
- `RBO_CONTROLLER_SCHEMA_VERSION`: bump together with adding a new entry to
  `apps/controller/src/storage/migrations.ts`'s `MIGRATIONS` array. A test in
  `apps/controller/test/storage.test.ts` fails the build if these two drift apart.

The root `package.json` `"version"` field is the workspace/monorepo version and isn't read by any
runtime code — keep it in sync with the constants above for humans reading `git tag`/`npm view`,
but nothing enforces it.

## Full verification gate

```bash
pnpm format   # biome autofix — always run before verify
pnpm verify   # the only command that decides "ready to release"
```

`pnpm verify` runs, in order: `lint` (biome check) → `build` (tsc across all 9 workspace
packages/apps) → `test` (all vitest suites) → `rust:verify` (`cargo fmt --check`, `cargo test`,
then `cargo build --release` for `native/windows-executor`) → `package:archives` (recompute real
sha256/size for every file in `packaging/{windows,macos,linux}/MANIFEST.json` from the just-built
`dist/` output and the just-built release `.exe`) → `package:verify` (re-check those manifests:
forbidden-path exclusions, required components present, and — critically — every checksum
re-verified against the actual file on disk, not just checked for hex-looking shape).

Must exit `0` before a release is considered ready. If `package:verify` fails with `sha256
mismatch ... manifest is stale`, you forgot to re-run `pnpm package:archives` after a source change
— `pnpm verify` does this for you, so in practice you should never see this outside of manually
running `package:verify` in isolation after editing `packaging/*/MANIFEST.json` by hand (don't).

## What's actually in a package

Each `packaging/<os>/MANIFEST.json` lists, per file: its in-archive `path`, real `sha256`,
`size_bytes`, and the repo-relative `source` it was hashed from. Windows lists 6 files (adds
`bin/rbo-windows-executor.exe`); macOS/Linux list 5 (no native binary — see Known limitations).

```text
bin/rbo-controller.js      ← apps/controller/dist/main.js
bin/rbo-agent.js           ← apps/agent/dist/main.js
bin/rbo.js                 ← apps/cli/dist/main.js  (the `rbo` CLI)
bin/rbo-mcp-stdio.js       ← apps/mcp-stdio/dist/main.js
bin/rbo-windows-executor.exe ← native/windows-executor/target/release/rbo-windows-executor.exe (Windows only)
config/controller.example.json ← packaging/<os>/config/controller.example.json (reference only, not loaded by any code — see getting-started.md)
```

`packages/shared/src/packaging.ts`'s `PACKAGING_FORBIDDEN_PATH_PATTERNS` is the single source of
truth for what must never ship: identity keys, `.env`, credentials, caches, logs, snapshots,
attempts, `node_modules`, `.pem`/`.key` files. `scripts/package-archives.mjs` imports it directly
(not a duplicated copy) and both `refreshManifest`/`verifyOnly` reject any listed file that matches.

## Assembling the actual archive

`pnpm package:archives`/`pnpm package:verify` produce and verify the **manifest** (a hashed,
audited list of what belongs in the package) — they do not yet zip/tar anything. To produce a real
distributable archive today:

```bash
# from repo root, after `pnpm verify` has passed
mkdir -p /tmp/rbo-windows-0.1.0
node -e "
  const fs = require('fs'); const path = require('path');
  const m = JSON.parse(fs.readFileSync('packaging/windows/MANIFEST.json', 'utf8'));
  for (const f of m.files) {
    const dest = path.join('/tmp/rbo-windows-0.1.0', f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.source, dest);
  }
  fs.copyFileSync('packaging/windows/MANIFEST.json', '/tmp/rbo-windows-0.1.0/MANIFEST.json');
"
# then zip/tar /tmp/rbo-windows-0.1.0 as rbo-windows-0.1.0.zip and publish its own sha256 alongside it
```

Repeat per OS, substituting the manifest path. Scripting this loop into
`scripts/package-archives.mjs` (a `--archive` mode) would be a reasonable follow-up if this becomes
a frequent manual step — it isn't built yet, so don't claim otherwise in release notes.

## Known limitations (be honest about these when writing release notes)

- **Windows-only native containment.** `native/windows-executor` (Win32 Job Objects) is the only
  real process-tree containment; macOS/Linux packages run scripts without an equivalent isolation
  layer today.
- **Service install is dry-run by default everywhere.** `rbo agent install`/`uninstall`/`status`
  print the exact `sc.exe`/`launchctl`/`systemctl` commands; they only execute with an explicit
  `--execute` flag (and elevation). There is no fully-automated, un-flagged service install path.
- **Wire protocol is a single version today** (`min = max = 1`). Upgrade/downgrade tests are
  correspondingly a two-case check (accept the one supported version, reject anything else), not a
  multi-version matrix — that's inherent to there being only one version defined, not a test gap.
- **AI client compatibility is `not_verified` for every real product client** (Fusion, Codex,
  Claude, Cursor, Antigravity) until someone actually runs the smoke workflow against that client
  and records the evidence in `docs/compatibility/evidence/`. See
  [`docs/compatibility/report.md`](../compatibility/report.md).

## Pre-release checklist

1. Bump version constants (see above) in a dedicated commit.
2. `pnpm format && pnpm verify` — exit 0.
3. Assemble and smoke-test at least one real archive per supported OS (extract it somewhere clean,
   follow [`docs/ops/getting-started.md`](../ops/getting-started.md) end-to-end).
4. Tag the commit; publish the archives + their own sha256 sums.
5. Update `docs/compatibility/report.md`/`matrix.json` with any new real client evidence gathered
   before or during the release — don't infer compatibility that wasn't actually tested.
