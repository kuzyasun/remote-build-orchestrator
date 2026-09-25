# Local development: compile, pack, and install

This guide describes how to compile RBO from source, package local archives, and install or run RBO locally during development.

---

## Prerequisites

| Tool | Requirement | Notes |
| --- | --- | --- |
| Node.js | ≥ 24.0 | Matches `.nvmrc` and `engines` in `package.json` |
| pnpm | 10.5.2 | Pinned via `"packageManager"` in root `package.json` |
| Git | on `PATH` | Required for dirty snapshots and tests |
| Rust | 1.93.0 | Required on Windows x64 for the native Job Object executor |

---

## 1. Setup repository

Clone and install dependencies:

```bash
git clone https://github.com/kuzyasun/remote-build-orchestrator.git
cd remote-build-orchestrator
pnpm install
```

---

## 2. Compile from source

### TypeScript and esbuild bundles

Compile all workspace packages (`@rbo/*`) and bundle the CLI / MCP proxy (`@gemslibe/rbo`):

```bash
pnpm build
```

This generates:
- `apps/cli/dist/rbo.js` — the main unified CLI executable.
- `apps/cli/dist/rbo-mcp-stdio.js` — the stdio MCP proxy for AI coding clients.
- `packages/*/dist/` and `apps/*/dist/` — compiled TypeScript declarations and outputs.

### Native Windows executor (Windows x64 only)

If developing or running on Windows x64, compile the Rust Job Object executor helper:

```powershell
cargo build --release --manifest-path native/windows-executor/Cargo.toml
pnpm --filter @gemslibe/rbo-windows-executor-win32-x64 prepare-binary:require
```

This stages `rbo-windows-executor.exe` into `packages/rbo-windows-executor-win32-x64/bin/`.

---

## 3. Fast inner-loop development (without global install)

You can run the freshly compiled code directly from the repository without packing or installing globally:

```bash
# Check status and diagnostics:
node apps/cli/dist/rbo.js doctor

# Run controller in foreground:
node apps/cli/dist/rbo.js controller start

# Run any rbo command:
node apps/cli/dist/rbo.js --help
```

When you edit code in `apps/cli/` or internal packages, rebuild the bundle:

```bash
pnpm build
# or just the CLI bundle:
pnpm --filter @gemslibe/rbo build
```

---

## 4. Package local tarballs (`.tgz`)

### Automated pack (recommended)

To compile the native helper (on Windows x64), verify bundle outputs, and pack both publishable packages:

```bash
pnpm release:pack
```

### Manual package pack

Alternatively, pack individual packages using pnpm:

```powershell
# Windows x64 optional native executor helper:
pnpm pack:windows-executor
# equivalent to: pnpm --dir packages/rbo-windows-executor-win32-x64 pack

# Main CLI package:
pnpm pack:rbo
# equivalent to: pnpm --dir apps/cli pack
```

> [!IMPORTANT]
> **Always use `pnpm pack` (or `pnpm release:pack`), never `npm pack`!**
> 
> In a pnpm monorepo, internal dependencies and optional dependencies use `workspace:*` protocol specifiers. `pnpm pack` automatically converts these into valid semantic version numbers.
> 
> Running `npm pack` directly will preserve raw `workspace:...` strings in the generated `package.json`, which causes `npm install` to fail with:
> ```text
> npm error code EUNSUPPORTEDPROTOCOL
> npm error Unsupported URL Type "workspace:"
> ```

---

## 5. Install globally from local packages

### Windows x64

On Windows x64, install the optional native executor package first, followed by the main CLI package:

```powershell
# 1. Install native helper:
npm install -g .\packages\rbo-windows-executor-win32-x64\gemslibe-rbo-windows-executor-win32-x64-0.8.0.tgz

# 2. Install main CLI:
npm install -g .\apps\cli\gemslibe-rbo-0.8.0.tgz
```

*(Tip: in PowerShell, you can also use `npm install -g (Get-Item apps\cli\*.tgz).FullName`)*

### Linux / macOS

On Linux or macOS (where the Windows helper is not used):

```bash
npm install -g ./apps/cli/gemslibe-rbo-0.8.0.tgz
```

> [!NOTE]
> During `npm install -g`, RBO automatically runs `scripts/stop-running-rbo.mjs` (`preinstall` hook). It cleanly stops any background Controller or Agent daemons before replacing the installed files.

---

## 6. Verify your local installation

After global installation, confirm that the system resolves the newly installed binary:

```bash
rbo --help
rbo doctor
```

Expected `rbo doctor` output:
- `node_engines`: satisfies `>=24.0`
- `windows_executor`: path under global `npm/node_modules/...` (on Windows x64)
- `controller_ports`: reports TCP 7410/7411 availability or active PID
- `mdns_port`: reports UDP 5353 multicast sharing status
- `firewall`: confirms whether inbound traffic is permitted or warns with the exact rule command

---

## 7. Workflow: iterating on changes

When developing a fix or feature:

1. **Implement changes** in `apps/` or `packages/`.
2. **Format and run targeted tests**:
   ```bash
   pnpm format
   pnpm --filter @rbo/protocol test
   pnpm exec vitest run apps/cli/test/doctor.test.ts
   ```
3. **Rebuild**:
   ```bash
   pnpm build
   ```
4. **Re-pack & Re-install**:
   ```powershell
   pnpm --dir apps/cli pack
   npm install -g .\apps\cli\gemslibe-rbo-0.8.0.tgz
   ```
5. **Run the final validation gate before commit**:
   ```bash
   pnpm format
   pnpm verify
   ```
