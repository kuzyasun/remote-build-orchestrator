# Remote Build Orchestrator (RBO)

Local system for distributed execution of build/test/QEMU/Docker jobs for interactive AI development. AI coding clients (Fusion, Codex, Claude, Cursor, Antigravity) submit jobs via MCP; Controller creates a snapshot of the dirty workspace and executes it on remote worker Agents.

Design: [remote-build-orchestrator-design.md](remote-build-orchestrator-design.md).

## Status

Implemented **Phase 0** (§35): monorepo skeleton, shared Zod schemas, versioned wire protocol, structured errors, Rust helper JSON protocol. Controller, Agent, CLI, and MCP adapter are currently stubs; execution is not yet implemented.

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
apps/controller    # Controller/Orchestrator (MCP, scheduler, snapshots) — stub
apps/agent         # Worker agent daemon — stub
apps/cli           # rbo CLI — stub
apps/mcp-stdio     # stdio → loopback Controller proxy — stub
packages/protocol  # canonical Zod schemas + wire messages (source of truth, §13/§20)
packages/snapshot  # snapshot manifest schemas (§11/§12)
packages/shared    # errors, ids, hashing, paths, logging
packages/testing   # test fixtures
native/windows-executor  # Rust Job Object helper (§15.2)
```
