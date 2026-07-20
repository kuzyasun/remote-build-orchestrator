# CLAUDE.md

Instructions for Claude and other AI tools working in this repository.

> [!IMPORTANT]
> This file mirrors [AGENTS.md](file:///c:/projects/gemslibe/rm-builder/AGENTS.md). `AGENTS.md` is the primary source of truth. If the two ever conflict, `AGENTS.md` wins and `CLAUDE.md` should be updated to match.

## Purpose & Scope

- **Remote Build Orchestrator (RBO)**: A local distributed system for executing build, test, QEMU, and Docker jobs for interactive AI development.
- AI coding clients (Fusion, Codex, Claude, Cursor, Antigravity) submit jobs via MCP. The Controller creates dirty workspace snapshots and executes them on remote worker Agents.
- Optimize for correctness, safety, and maintainability first; keep context and tool outputs lean.
- Apply local monorepo package conventions and prefer focused, minimal diffs over broad refactors.

## Repository Map

- `apps/controller/`: Controller / Orchestrator daemon (MCP server, scheduler, dirty workspace snapshots) — *stub phase*.
- `apps/agent/`: Remote worker agent daemon — *stub phase*.
- `apps/cli/`: `rbo` CLI executable — *stub phase*.
- `apps/mcp-stdio/`: Stdio to loopback Controller MCP proxy — *stub phase*.
- `packages/protocol/`: Canonical Zod schemas and wire messages (Source of truth for wire contracts, §13/§20).
- `packages/snapshot/`: Workspace snapshot manifest and transfer schemas (§11/§12).
- `packages/shared/`: Shared errors, ID generators, hashing utilities, path helpers, and logger.
- `packages/testing/`: Shared test fixtures and harness helpers.
- `native/windows-executor/`: Rust Job Object process isolation helper for Windows (§15.2).
- `remote-build-orchestrator-design.md`: Canonical architectural design specification.

## Stack Summary

- **Runtime & Package Management**: Node.js ≥ 22.14 (`.nvmrc`), pnpm 10.5.2 (`packageManager` in `package.json`, pnpm workspace).
- **TypeScript & Build**: TypeScript strict mode (`tsconfig.base.json`), tsc build outputs under `dist/`.
- **Formatting & Linting**: Biome 1.9.4 (`biome.json`, checks format, lint, import order).
- **Testing**: Vitest 3.0.7 (`vitest.config.ts`).
- **Native Executor**: Rust 1.93.0 (`rust-toolchain.toml`, `Cargo.toml`), Cargo workspace.

## Source Of Truth

Consult in this order before modifying or designing code:

1. **Nearby code & existing tests** in the target package/app.
2. **`packages/protocol/`**: Zod schemas and wire protocol definitions (§13/§20).
3. **`remote-build-orchestrator-design.md`**: Architectural specification and protocol design.
4. **Subproject manifests**:
   - `package.json`, `pnpm-workspace.yaml`
   - `biome.json`, `tsconfig.base.json`
   - `native/windows-executor/Cargo.toml`, `rust-toolchain.toml`
5. **Root `README.md`**: Monorepo high-level overview.

## Canonical Commands

Run commands from repo root or with `--filter`:

- Monorepo setup: `pnpm install`
- Full verification (lint + build + unit tests + Rust fmt/test): `pnpm verify`
- TypeScript unit tests: `pnpm test` (or `pnpm --filter @rbo/protocol test`)
- Lint & Format: `pnpm lint` / `pnpm format`
- Typechecking: `pnpm typecheck`
- Rust verification: `pnpm rust:verify`

## Working Rules & Efficiency

- **Keep diffs small**: Modify only what is necessary for the task. Avoid broad reformatting or unrequested cleanups.
- **Preserve wire contracts**: Do not change Zod schemas in `packages/protocol` or message structures without updating tests and matching Rust protocol helpers in `native/windows-executor`.
- **No Git Index modification**: Never run `git add`, `git reset`, or `git restore --staged` on your own. Leave staging control to the user.
- **Documentation language**: Write all committed files (`README.md`, `AGENTS.md`, `CLAUDE.md`, code comments, docstrings, commit messages) in **English**. User chat responses may use the user's language.
- **First version — No migration shims**: Phase 0 product; replace schemas cleanly with single new contract rather than writing backward compatibility wrappers.

## Token Economy & Context Strategy

- Avoid reading generated output directories (`dist/`, `node_modules/`, `target/`, `.turbo/`, `.vitest/`).
- Use grep/ripgrep to locate definitions before reading whole files.
- Prefer targeted validation (`pnpm test`, `cargo test`) before broad `pnpm verify`.

## Safety & Guardrails

- Keep TypeScript Zod schemas (`packages/protocol`) and Rust protocol structs (`native/windows-executor`) synchronized.
- Never commit secrets or credentials. Use `.env` files.
- Exercise caution with Windows process isolation & Job Objects handle lifetimes in `native/windows-executor`.
