# CLAUDE.md

Instructions for Claude and other AI tools working in this repository.

> [!IMPORTANT]
> This file mirrors [AGENTS.md](file:///c:/projects/gemslibe/rm-builder/AGENTS.md). `AGENTS.md` is the primary source of truth. If the two ever conflict, `AGENTS.md` wins and `CLAUDE.md` should be updated to match.

## Purpose & Scope

- **Remote Build Orchestrator (RBO)**: A local distributed system for executing build, test, QEMU, and Docker jobs for interactive AI development.
- AI coding clients (Codex, Claude, Cursor, Antigravity) submit jobs via MCP. The Controller creates dirty workspace snapshots and executes them on remote worker Agents.
- Optimize for correctness, safety, and maintainability first; keep context and tool outputs lean.
- Apply local monorepo package conventions and prefer focused, minimal diffs over broad refactors.

## Repository Map

- `apps/controller/`: Controller / Orchestrator daemon (MCP server, scheduler, snapshots, remote execution, reconciliation, ops).
- `apps/agent/`: Remote worker agent daemon (execution, recovery, build cache, Docker cleanup, repo mirrors).
- `apps/cli/`: `rbo` CLI executable (controller init/fingerprint/restore, agent pairing/service lifecycle, job submit/logs/cancel, doctor).
- `apps/mcp-stdio/`: Stdio to loopback Controller MCP proxy.
- `packages/protocol/`: Canonical Zod schemas and wire messages (Source of truth for wire contracts, §13/§20).
- `packages/snapshot/`: Workspace snapshot manifest, capture, and materialization (§11/§12).
- `packages/executor/`: Shared platform execution adapters (Unix/Windows process lifecycle, artifacts, logs) used by both Controller-local and Agent-remote execution.
- `packages/shared/`: Shared errors, ID generators, hashing utilities, path/packaging helpers, crypto, controller identity, and logger.
- `packages/testing/`: Shared test fixtures and harness helpers.
- `native/windows-executor/`: Rust Job Object process isolation helper for Windows (§15.2).
- `packaging/`: Per-OS packaging manifests and config templates (see `docs/dev/release-builds.md`).
- `docs/dev/release-builds.md`: How to build a release and publish `@gemslibe/rbo` to npm.
- `docs/ops/getting-started.md`: Operator walkthrough — Controller/Agent setup, pairing, MCP client wiring.
- `docs/ops/runbook.md`: Day-2 operator procedures (install/pair/drain/revoke/repair/update/backup/restore/uninstall).
- `remote-build-orchestrator-design.md`: Canonical architectural design specification.

## MCP client wiring (for consuming projects)

This monorepo **is** RBO. Do **not** route this repo's own `pnpm build` / `pnpm verify` / package
tests through MCP `job_run` as the default workflow — develop and verify here with Canonical
Commands below.

For **other** projects (firmware, clients, etc.) that should call this Controller over MCP, see
[`docs/ops/getting-started.md`](docs/ops/getting-started.md) §§6–8 (client snippets, `job_run`
preferred for AI clients, paste-ready AGENTS.md guidance including **Shell vs agent OS**). Server
names in clients are typically `rbo` or `user-rbo`. AI agents use pull-based `job_logs`; live follow
is CLI `rbo logs --follow` for human operators. Consumer note: match shell/command to the live
worker agent OS (`agents_list`); `job_run` wraps shell from Controller OS (no `shell` arg) — do not
submit PowerShell jobs when only a Mac/Linux agent is online.

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
- Build (tsc + esbuild → `dist/`): `pnpm build`
- Verification (lint + unit tests + Rust fmt/test — does **not** build): `pnpm verify`
- TypeScript unit tests: `pnpm test` (or `pnpm --filter @rbo/protocol test`)
- Lint & Format: `pnpm lint` / `pnpm format`
- Typechecking: `pnpm typecheck`
- Rust verification: `pnpm rust:verify` (`cargo fmt --check` + `cargo test`)
- Packaging manifests (after build): `pnpm package:archives` / `pnpm package:verify`

## Working Rules & Efficiency

- **Keep diffs small**: Modify only what is necessary for the task. Avoid broad reformatting or unrequested cleanups.
- **Preserve wire contracts**: Do not change Zod schemas in `packages/protocol` or message structures without updating tests and matching Rust protocol helpers in `native/windows-executor`.
- **No Git Index modification**: Never run `git add`, `git reset`, or `git restore --staged` on your own. Leave staging control to the user.
- **Documentation language**: Write all committed files (`README.md`, `AGENTS.md`, `CLAUDE.md`, code comments, docstrings, commit messages) in **English**. User chat responses may use the user's language.
- **First version — No migration shims**: no production fleet requiring backward compatibility yet; replace schemas cleanly with single new contract rather than writing backward compatibility wrappers.
- **Final gate after code changes**: After completing implementation or fixes, MUST run `pnpm format` then `pnpm verify` before claiming work complete. Use targeted tests during iteration; do not skip this final gate.

## Token Economy & Context Strategy

- Avoid reading generated output directories (`dist/`, `node_modules/`, `target/`, `.turbo/`, `.vitest/`).
- Use grep/ripgrep to locate definitions before reading whole files.
- Prefer targeted validation (`pnpm test`, `cargo test`) during development. Before claiming work complete, apply the final gate (`pnpm format` then `pnpm verify`).

## Safety & Guardrails

- Keep TypeScript Zod schemas (`packages/protocol`) and Rust protocol structs (`native/windows-executor`) synchronized.
- Never commit secrets or credentials. Use `.env` files.
- Exercise caution with Windows process isolation & Job Objects handle lifetimes in `native/windows-executor`.
