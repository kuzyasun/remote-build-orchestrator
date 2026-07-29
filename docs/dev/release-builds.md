# Release & publish

How to cut an RBO release from this monorepo and publish to npm.

Audience: maintainers releasing from this repo. Operators installing an already-published package
should use [`docs/user/getting-started.md`](../user/getting-started.md).

| Package | Monorepo path | What it ships |
| --- | --- | --- |
| `@gemslibe/rbo` | `apps/cli/` | Bundled `rbo` + `rbo-mcp-stdio` (CLI, Controller, Agent, MCP) |
| `@gemslibe/rbo-windows-executor-win32-x64` | `packages/rbo-windows-executor-win32-x64/` | `bin/rbo-windows-executor.exe` (win32-x64 only) |

Other workspace packages (`@rbo/*`) are **not** published; they are inlined into the `@gemslibe/rbo`
esbuild bundle. OS archives (see [Offline archives](#offline-archives)) are an offline/air-gap
fallback at the **same** product semver.

There is **no** mega-script that bumps, packs, and publishes in one shot. Bump is interactive;
publish is gated. Run the commands below in order.

---

## Quick release

From the repo root on a **Windows x64** machine (required for the optional package):

```powershell
pnpm format          # optional but recommended before verify
pnpm verify          # lint + Vitest + Rust fmt/test (does not build)
pnpm build           # tsc + esbuild → apps/cli/dist
pnpm package:archives
pnpm package:verify
pnpm bump-version    # or: pnpm bump-version 1.2.3
pnpm release:pack    # cargo release build (win32-x64) + pack .tgz
$env:RELEASE_CONFIRM=1; pnpm release:publish
# equivalent: pnpm release:publish --yes
```

`pnpm verify` runs checks and tests only. `pnpm build` produces distributable JS bundles.
Format is separate; run `pnpm format` when you want autofix before the gate.

After publish, smoke on a clean Windows x64 host:

```powershell
npm install -g @gemslibe/rbo
rbo --help
rbo doctor   # expect: OK windows_executor
```

Then follow [`docs/user/getting-started.md`](../user/getting-started.md) (init → start → pair → submit).

---

## Prerequisites

| Tool | Requirement |
| --- | --- |
| Node.js | ≥ 22.14 (see `.nvmrc`) |
| pnpm | 10.5.2 (pinned via `"packageManager"` in root `package.json`) |
| Git | on `PATH` |
| Rust | 1.93.0 (`rust-toolchain.toml`) — **required on the Windows x64 host that packs/publishes the optional package** |
| npm | logged in with permission to publish under the **`gemslibe`** org |

```powershell
node -v          # v22.14.x or newer
pnpm -v          # 10.5.2
npm whoami       # must succeed; account must publish under @gemslibe
```

First-time clone:

```powershell
git clone <this repo>
cd rm-builder
pnpm install
```

> **Windows host for the optional package.** That package's `prepack` hard-requires a real
> `rbo-windows-executor.exe`. Build and publish from Windows x64. You can develop elsewhere, but do
> not skip the Windows step for a public release.

---

## Detailed steps

### 1. Verify (checks + tests)

```powershell
pnpm format   # optional autofix
pnpm verify
```

`pnpm verify` must exit `0`. It runs, in order (root `package.json` → `scripts.verify`):

1. `lint` — Biome check
2. `test` — all Vitest suites (resolve to TypeScript sources; no prior `pnpm build` required)
3. `rust:verify` — `cargo fmt --check` + `cargo test` for `native/windows-executor`

It does **not** compile TypeScript/esbuild bundles, refresh packaging manifests, or run
`cargo build --release` (those belong to `pnpm build` / `pnpm package:archives` / `pnpm release:pack`).

### 1b. Build + packaging manifests

```powershell
pnpm build
pnpm package:archives   # refresh packaging/{windows,macos,linux}/MANIFEST.json hashes/sizes
pnpm package:verify     # re-check manifests (forbidden paths, required files, checksums)
```

`pnpm build` runs tsc across workspace packages and esbuild for `@gemslibe/rbo`
(`apps/cli` → `dist/rbo.js`, `dist/rbo-mcp-stdio.js`).

If `package:verify` fails with `sha256 mismatch ... manifest is stale`, re-run
`pnpm package:archives` after source/build changes.

Confirm CLI bundles after a successful build:

```powershell
Test-Path .\apps\cli\dist\rbo.js
Test-Path .\apps\cli\dist\rbo-mcp-stdio.js
# expect: True / True
```

### 2. Bump version (single product semver)

One semver `x.y.z` for the product. Bump **all** lockstep sites together — never ship mismatched
runtime constants vs published package versions.

```powershell
pnpm bump-version          # interactive: prints current, asks for new x.y.z
pnpm bump-version 1.2.3    # non-interactive override
```

That runs `scripts/bump-version.mjs`. Internal `@rbo/*` workspace packages are not published and are
left alone.

| Location | Field(s) |
| --- | --- |
| `packages/shared/src/versions.ts` | `RBO_CONTROLLER_VERSION`, `RBO_AGENT_VERSION`, `RBO_STDIO_ADAPTER_VERSION` |
| `apps/cli/package.json` | `"version"` **and** `optionalDependencies["@gemslibe/rbo-windows-executor-win32-x64"]` |
| `packages/rbo-windows-executor-win32-x64/package.json` | `"version"` |
| Root `package.json` | `"version"` (workspace label; not read at runtime) |
| `packaging/{windows,macos,linux}/MANIFEST.json` | `package_version` and `components.*` |

Example constants (keep the three runtime strings identical):

```ts
export const RBO_CONTROLLER_VERSION = '0.1.0';
export const RBO_AGENT_VERSION = '0.1.0';
export const RBO_STDIO_ADAPTER_VERSION = '0.1.0';
```

Also in `versions.ts` (bump only when the contract/schema actually changes — not every release;
`pnpm bump-version` does **not** touch these):

- `RBO_WIRE_PROTOCOL_MIN_VERSION` / `MAX_VERSION` — only when the wire contract changes. No
  migration shims (`AGENTS.md`).
- `RBO_CONTROLLER_SCHEMA_VERSION` — bump together with a new entry in
  `apps/controller/src/storage/migrations.ts` (`MIGRATIONS`). A test fails if these drift.

`bump-version` does **not** pack or publish. Commit the version bump before tagging/publishing
(human judgment on commit/tag message).

### 3. Build and pack (`pnpm release:pack`)

Preferred (Windows x64, repo root):

```powershell
pnpm release:pack
```

What it does:

1. `cargo build --release --manifest-path native/windows-executor/Cargo.toml` (Windows x64 only)
2. `pnpm --filter @gemslibe/rbo-windows-executor-win32-x64 prepare-binary:require` — stages
   `packages/rbo-windows-executor-win32-x64/bin/rbo-windows-executor.exe` (fails if missing)
3. Checks CLI `dist/` bundles exist
4. Packs optional package, then `@gemslibe/rbo`, via `pnpm --dir <path> pack`

> **Do not use `pnpm --filter … pack`.** On pnpm 10.x, `--filter` implies recursive mode, and
> `pack` rejects that (`Unknown option: 'recursive'`). Root scripts use `pnpm --dir … pack`.

Success: tarballs under the package directories, e.g.

```text
packages\rbo-windows-executor-win32-x64\gemslibe-rbo-windows-executor-win32-x64-0.1.0.tgz
apps\cli\gemslibe-rbo-0.1.0.tgz
```

#### Manual pack (one piece at a time)

If `release:pack` fails mid-way, or you only need one package:

```powershell
# 1. Cargo release binary
cargo build --release --manifest-path native/windows-executor/Cargo.toml
Test-Path .\native\windows-executor\target\release\rbo-windows-executor.exe
# expect: True

# 2. Stage exe (hard-require; do not use soft prepare-binary for a release)
pnpm --filter @gemslibe/rbo-windows-executor-win32-x64 prepare-binary:require
Test-Path .\packages\rbo-windows-executor-win32-x64\bin\rbo-windows-executor.exe
# expect: True

# 3. Pack optional package
pnpm pack:windows-executor
# equivalent: pnpm --dir packages/rbo-windows-executor-win32-x64 pack

# 4. Ensure CLI bundles (skip if `pnpm build` just succeeded)
pnpm --filter @gemslibe/rbo build

# 5. Pack main package
pnpm pack:rbo
# equivalent: pnpm --dir apps/cli pack
```

Optional inspect (lists included files; optional tarball must include
`bin/rbo-windows-executor.exe`):

```powershell
cd .\packages\rbo-windows-executor-win32-x64
npm pack --dry-run
cd ..\..

cd .\apps\cli
npm pack --dry-run
cd ..\..
```

Package scripts for the Windows executor:

| Script | Behavior |
| --- | --- |
| `prepare-binary` | Soft copy from Cargo `target/` — warns and exits 0 if missing |
| `prepare-binary:require` | Hard require — exits 1 unless Cargo output **or** staged `bin/…exe` exists |
| `prepack` | Same as `--require` — runs automatically on `pnpm pack` / `npm pack` / `npm publish` |

`apps/cli` has **no** `prepack` hook — run `pnpm build` (or `pnpm --filter @gemslibe/rbo build`)
before packing. Published `"files"`: `dist/rbo.js`, `dist/rbo-mcp-stdio.js`,
`config/controller.json`, `config/agent.json`, `scripts/stop-running-rbo.mjs`, `LICENSE`,
`README.md`. The stop script is the `preinstall` / `preuninstall` hook that terminates running
Controller/Agent processes before global reinstall (see `docs/user/getting-started.md`).

#### Dry-run smoke from local tarballs

Prefer optional package published (or its `.tgz` installed) before installing the main `.tgz`:

```powershell
# Optional local dry-run of both on Windows x64:
npm install -g .\packages\rbo-windows-executor-win32-x64\gemslibe-rbo-windows-executor-win32-x64-0.1.0.tgz
npm install -g .\apps\cli\gemslibe-rbo-0.1.0.tgz
rbo --help
rbo doctor
npm uninstall -g @gemslibe/rbo
```

### 4. Publish (`pnpm release:publish`)

Publish `@gemslibe/rbo-windows-executor-win32-x64` **before** `@gemslibe/rbo`. The main package pins
that optionalDependency at the **same** semver; publishing main first leaves Windows installs unable
to fetch a matching helper.

**Safety gate:** publish refuses to run unless you confirm:

```powershell
$env:RELEASE_CONFIRM=1; pnpm release:publish
# or:
pnpm release:publish --yes
```

Requires `npm login` to an account that can publish under the **`gemslibe`** org (2FA/OTP as npm
requires). The script publishes from each package directory (`npm publish --access public`):
optional first, then main.

Confirm on the registry:

```powershell
npm view @gemslibe/rbo-windows-executor-win32-x64 version
npm view @gemslibe/rbo version
# expect: the same product semver you bumped
```

#### Manual publish (one package at a time)

```powershell
cd .\packages\rbo-windows-executor-win32-x64
npm publish --access public
cd ..\..

cd .\apps\cli
npm publish --access public
cd ..\..
```

Or publish the packed tarballs (replace the version in the filename):

```powershell
npm publish --access public .\packages\rbo-windows-executor-win32-x64\gemslibe-rbo-windows-executor-win32-x64-0.1.0.tgz
npm publish --access public .\apps\cli\gemslibe-rbo-0.1.0.tgz
```

### 5. Post-publish smoke

On a **clean Windows x64** machine (no monorepo checkout required):

1. Node.js ≥ 22.14 installed.
2. `npm install -g @gemslibe/rbo`
3. Confirm bins: `rbo --help`, `rbo-mcp-stdio` on `PATH`.
4. Follow [`docs/user/getting-started.md`](../user/getting-started.md):
   - `rbo controller init` and `rbo agent init`
   - `rbo controller start` / `rbo agent start`
   - Pair Agent → Controller
   - Submit a trivial job
5. `rbo doctor` — expect **`OK windows_executor`** (not WARN). A WARN on win32-x64 after a
   successful global install usually means the optional package failed to download or was skipped.

Treat the release as incomplete until this smoke path passes.

---

## Offline archives

`pnpm package:archives` / `pnpm package:verify` refresh and check **manifests**; they do not zip/tar
yet. Each `packaging/<os>/MANIFEST.json` lists in-archive `path`, `sha256`, `size_bytes`, and
repo-relative `source`.

Typical layout:

```text
bin/rbo.js                      ← apps/cli/dist/rbo.js
bin/rbo-mcp-stdio.js            ← apps/cli/dist/rbo-mcp-stdio.js
bin/rbo-windows-executor.exe    ← Windows only (Cargo release output)
config/controller.json          ← apps/cli/config/… (template; live copy is ~/.rbo/controller.json)
config/agent.json               ← apps/cli/config/… (template; live copy is ~/.rbo/agent/agent.json)
```

Forbidden paths (identity keys, `.env`, credentials, caches, logs, `node_modules`, …) are defined
once in `packages/shared/src/packaging.ts` (`PACKAGING_FORBIDDEN_PATH_PATTERNS`) and enforced by
`scripts/package-archives.mjs`.

Assemble a distributable after `pnpm build` (and preferably `pnpm package:archives`) — PowerShell,
Windows example:

```powershell
$dest = Join-Path $env:TEMP "rbo-windows-0.1.0"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$env:RBO_ARCHIVE_DEST = $dest
node -e "const fs=require('fs');const path=require('path');const dest=process.env.RBO_ARCHIVE_DEST;const m=JSON.parse(fs.readFileSync('packaging/windows/MANIFEST.json','utf8'));for (const f of m.files){const out=path.join(dest,f.path);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(f.source,out);}fs.copyFileSync('packaging/windows/MANIFEST.json',path.join(dest,'MANIFEST.json'));"
Compress-Archive -Path (Join-Path $dest '*') -DestinationPath "$dest.zip" -Force
# publish the zip + its own sha256 alongside it
```

Archives are the air-gap fallback; **npm remains the primary** distribution channel.

---

## License reminder

- Default public terms: **AGPL-3.0-only** (`LICENSE` in both published packages;
  `"license": "AGPL-3.0-only"` in each `package.json`).
- Local use as a tool is fine under AGPL; offering RBO (or a modified/embedded form) **as a
  service**, or embedding it into a proprietary product without AGPL compliance, needs a
  **separate commercial license** (see `apps/cli/README.md`).
- Do not invent a custom SPDX string. Do not publish without `LICENSE` in the tarball.

---

## Common failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `prepack` / `prepare-binary:require` / `release:pack` exits 1 | No `.exe` in Cargo `target/{release,debug}/` and none staged under `bin/` | Build on Windows x64: `cargo build --release --manifest-path native/windows-executor/Cargo.toml`, then `prepare-binary:require` |
| `release:publish` refuses without confirmation | Missing safety gate | `$env:RELEASE_CONFIRM=1; pnpm release:publish` or `pnpm release:publish --yes` |
| `npm publish` 403 / forbidden | Not logged in, missing `gemslibe` org rights, or 2FA/OTP required | `npm login`; complete org invite; provide OTP if prompted |
| `engines` / install warnings | Node &lt; 22.14 | Upgrade Node; `rbo doctor` also surfaces mismatches |
| Optional package skipped | Non-Windows or non-x64 host (`os`/`cpu` in package.json) | Expected; `rbo doctor` WARNs. Only win32-x64 gets the helper automatically |
| `windows_executor` WARN on win32-x64 after `npm install -g` | Optional package not published yet, wrong semver pin, or network/registry failure | Publish optional package first at matching semver; reinstall; check `npm ls -g @gemslibe/rbo-windows-executor-win32-x64` |
| Main pack missing `dist/*.js` | Forgot `pnpm build` before pack | `pnpm build` or `pnpm --filter @gemslibe/rbo build` |
| `pnpm --filter … pack` → `Unknown option: 'recursive'` | pnpm 10.x: `--filter` implies recursive; `pack` does not support it | Use `pnpm release:pack`, `pnpm pack:windows-executor` / `pnpm pack:rbo`, or `pnpm --dir <pkg-path> pack` |
| `package:verify` sha256 mismatch | Stale manifest after edits | Run `pnpm build` then `pnpm package:archives` |
| Mismatched versions at runtime vs npm | Bumped only one of `versions.ts` / two package.json files / `optionalDependencies` | Re-run `pnpm bump-version` so all sites match |

---

## Known limitations (release notes)

Be honest when writing release notes:

- **Windows-only native containment.** Job Objects helper is win32-x64 only; other arches/OSes run
  without equivalent isolation.
- **Service install is dry-run by default / best-effort.** Prefer `rbo agent start --daemon`.
  `rbo agent install`/`uninstall`/`status` print platform commands targeting `node` + bundled
  `rbo.js agent start --state-dir …`; `--execute` (and elevation) required for real changes.
  Unit/plist files are not shipped yet — operators must create them from the printed hints.
- **Wire protocol** is a single version today (`min = max = 1`).
- **AI client compatibility** must be checked against the client versions named in the release
  notes. The transport workflow is automated, but real client UI/configuration smoke tests are
  environment-gated.

---

## Pre-release checklist

- [ ] `pnpm format` (optional) then `pnpm verify` exit 0
- [ ] `pnpm build` then `pnpm package:archives` && `pnpm package:verify`
- [ ] `pnpm bump-version` (or `pnpm bump-version x.y.z`) — lockstep sites updated
- [ ] Semver matches in `versions.ts`, `apps/cli/package.json` (including `optionalDependencies`),
      `packages/rbo-windows-executor-win32-x64/package.json`, and root `package.json`
- [ ] `LICENSE` + AGPL/`README` commercial note present on both publish packages
- [ ] `pnpm release:pack` on Windows x64 (or manual cargo → prepare-binary:require → pack steps)
- [ ] Optional `.tgz` contains `bin\rbo-windows-executor.exe`
- [ ] Dry-run smoke from tarballs (optional)
- [ ] `npm whoami` — logged in as a `gemslibe` publisher
- [ ] `$env:RELEASE_CONFIRM=1; pnpm release:publish` (optional package first, then main)
- [ ] Registry versions match: `npm view` both packages
- [ ] Clean Windows x64: global install → init → start → pair → submit
- [ ] `rbo doctor` shows `OK windows_executor`
- [ ] Tag / release notes updated; compatibility evidence only if actually tested
