# AGENTS.md

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
- `docs/dev/release-builds.md`: How to build and package a release from source.
- `docs/ops/getting-started.md`: Operator walkthrough — Controller/Agent setup, pairing, MCP client wiring.
- `docs/ops/runbook.md`: Day-2 operator procedures (install/pair/drain/revoke/repair/update/backup/restore/uninstall).
- `remote-build-orchestrator-design.md`: Canonical architectural design specification (implementation phases tracked in `PHASE_HANDOFFS.md`).

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

> [!NOTE]
> Do not treat temporary plans or scratch notes in `dev/` or root draft markdown files as canonical truth unless explicit in the prompt.

## Canonical Commands

Always execute commands from the repo root or use `--filter` for targeted operations:

- **Monorepo setup**:
  ```bash
  pnpm install
  ```
- **Full verification** (lint + build + unit tests + Rust fmt/test):
  ```bash
  pnpm verify
  ```
- **TypeScript unit tests**:
  ```bash
  pnpm test                             # run all Vitest suites
  pnpm --filter @rbo/protocol test      # targeted package test
  pnpm exec vitest run packages/protocol/src/index.test.ts  # targeted file
  ```
- **Lint & Format**:
  ```bash
  pnpm lint                            # biome check (lint + format + import order)
  pnpm format                          # biome autofix
  ```
- **Typechecking**:
  ```bash
  pnpm typecheck                       # tsc --noEmit (requires prior build of dependencies)
  ```
- **Rust verification**:
  ```bash
  pnpm rust:verify                     # cargo fmt --check + cargo test in native/windows-executor
  ```

## Working Rules & Efficiency

- **Keep diffs small**: Modify only what is necessary for the task. Avoid broad reformatting or unrequested cleanups.
- **Preserve wire contracts**: Do not change Zod schemas in `packages/protocol` or message structures without updating tests and matching Rust protocol helpers in `native/windows-executor`.
- **No Git Index modification**: Never run `git add`, `git reset`, or `git restore --staged` on your own. Leave staging control to the user.
- **Documentation language**: Write all committed files (`README.md`, `AGENTS.md`, `CLAUDE.md`, code comments, docstrings, commit messages) in **English**. User chat responses may use the user's language.
- **First version — No migration shims**:
  - There is no production fleet requiring backward compatibility yet.
  - Do not add schema aliases, dual wire format support, or deprecated fallback paths.
  - When changing a contract, replace it with the single new contract cleanly.
- **Final gate after code changes**: After completing implementation or fixes, MUST run `pnpm format` then `pnpm verify` before claiming work complete. Use targeted tests during iteration; do not skip this final gate.

## Token Economy & Context Strategy

- **Avoid reading generated/build outputs**: Do not inspect contents of `dist/`, `node_modules/`, `target/`, `.turbo/`, `.vitest/`, or build caches.
- **Use targeted searches**: Use ripgrep / grep search tool to locate definitions before reading whole files.
- **Targeted validation**: Run narrow vitest/cargo checks first during development. Before claiming work complete, apply the final gate (`pnpm format` then `pnpm verify`).

## Task Workflow

- **Simple tasks**: Inspect nearby files + package manifest, implement directly, run targeted tests during iteration, then apply the final gate (`pnpm format` then `pnpm verify`) before summarizing.
- **Medium / Risky tasks**:
  - Outline a brief plan.
  - Break implementation into small steps (e.g. `packages/protocol` Zod schema -> `packages/shared` -> `apps/controller` -> `native/windows-executor`).
  - Run targeted tests after each milestone.
  - Apply the final gate (`pnpm format` then `pnpm verify`) once implementation is complete.

## Safety & Guardrails

- **Wire protocol drift**: If Zod schemas in `packages/protocol` change, ensure `packages/snapshot` and Rust structs in `native/windows-executor` stay aligned.
- **Secrets**: Never hardcode or commit tokens, private keys, or credentials. Use `.env` files (ignored by git).
- **Process isolation**: `native/windows-executor` manages Job Objects on Windows. Handle Windows process handles and safety parameters carefully.

## When To Ask The User

Ask the user when ambiguity affects:
- Public wire protocol / Zod schema breaking changes.
- Architecture design deviations from `remote-build-orchestrator-design.md`.
- Hardware, OS, or environment-specific constraints (e.g., Windows Job Object parameters vs Linux cgroups).

Otherwise, make conservative assumptions based on `remote-build-orchestrator-design.md` and nearby code, and proceed.
