# Remote Build Orchestrator (RBO)

Local system for distributed execution of build/test/QEMU/Docker jobs for interactive AI development. AI coding clients (Codex, Claude, Cursor, Antigravity) submit jobs via MCP; Controller creates a snapshot of the dirty workspace and executes it on remote worker Agents.

Design: [remote-build-orchestrator-design.md](remote-build-orchestrator-design.md).

## Status

Phases 1–8 (§35) implemented: local MCP transports, secure Controller↔Agent connection, isolated
local execution, remote full-snapshot execution, Git mirror/overlay execution, long-running
reliability/reconciliation, QEMU/Docker validation with build caches, and client-compatibility/
release-hardening. See [`PHASE_HANDOFFS.md`](PHASE_HANDOFFS.md) for the per-phase specs and
[`docs/acceptance/phase8-section37.md`](docs/acceptance/phase8-section37.md) for the acceptance
checklist. Getting started: [`docs/ops/getting-started.md`](docs/ops/getting-started.md) (operator
setup) or [`docs/dev/release-builds.md`](docs/dev/release-builds.md) (building from source).

## Toolchain

- Node.js ≥ 22.14 (`.nvmrc`), pnpm 10.5.2 (`packageManager`)
- Rust 1.93.0 (`rust-toolchain.toml`)

## Commands

```bash
pnpm install
pnpm verify        # lint + build (typecheck) + unit tests + Rust fmt/test
pnpm test          # vitest only
pnpm lint          # biome check (format + lint + organize imports)
pnpm format        # biome autofix
pnpm typecheck     # tsc --noEmit across all packages (requires prior build of dependencies)
pnpm rust:verify   # cargo fmt --check + cargo test for native/windows-executor
```

## Structure

```text
apps/controller    # Controller/Orchestrator (MCP, scheduler, snapshots, remote execution, ops)
apps/agent         # Worker agent daemon (execution, recovery, build cache, repo mirrors)
apps/cli           # rbo CLI
apps/mcp-stdio     # stdio → loopback Controller proxy
packages/protocol  # canonical Zod schemas + wire messages (source of truth, §13/§20)
packages/snapshot  # snapshot capture/materialization (§11/§12)
packages/executor  # shared Unix/Windows execution adapters
packages/shared    # errors, ids, hashing, paths, packaging, crypto, controller identity, logging
packages/testing   # test fixtures
native/windows-executor  # Rust Job Object helper (§15.2)
packaging/         # per-OS packaging manifests (see docs/dev/release-builds.md)
docs/ops/          # getting-started.md, runbook.md, backup-restore.md, observability-report.md
docs/dev/          # release-builds.md
```
