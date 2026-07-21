# Architecture (for developers)

Audience: someone modifying RBO itself. If you just want to *use* RBO, see the
[README](../../README.md) and [`docs/ops/getting-started.md`](../ops/getting-started.md) instead.

## The problem this solves

An AI coding agent (Codex, Claude, Cursor, Antigravity, …) needs to run a build/test/QEMU/Docker
job, but running it directly in the developer's live working tree is risky: it mutates a dirty
tree the human is actively editing, ties up their machine, and gives no isolation between "AI ran
this" and "I ran this." RBO gives the AI agent an MCP tool (`job_submit`) that instead: takes an
exact, isolated snapshot of the current dirty working tree (uncommitted changes included), runs
the job against that snapshot on a separate worker (local fallback or a remote machine), and
returns logs + artifacts — without ever touching the developer's live tree.

## Components

```text
AI client (Codex/Claude/Cursor/Antigravity)
        │  MCP (stdio via rbo-mcp-stdio, or Streamable HTTP directly)
        ▼
┌───────────────────┐        TLS WebSocket (wss://…:7411/agent)      ┌───────────────┐
│     Controller     │ ───────────────────────────────────────────▶ │     Agent     │
│  apps/controller/   │ ◀─────────────────────────────────────────── │  apps/agent/  │
└───────────────────┘        job leases, logs, artifacts             └───────────────┘
        │
        ▼
   SQLite (jobs, attempts, events, artifacts, agents)
```

- **`apps/controller/`** — the one always-on process. Owns:
  - the MCP server (`src/mcp/`, `src/http/server.ts`) — the only thing an AI client talks to;
  - the scheduler (`src/scheduler/`) — picks which Agent (if any) gets a job, per §19.2's scoring
    formula plus hard filters (OS/arch/labels/memory/disk/toolchain/secrets);
  - snapshot capture (`src/execution/` + `packages/snapshot`) — turns a dirty working tree into an
    immutable, content-addressed manifest;
  - remote execution (`src/execution/remote-execution.ts`) — the lease/fencing state machine that
    hands a snapshot to an Agent and streams results back;
  - local execution (`src/execution/runner.ts`) — the Controller-local fallback path, used when no
    Agent is eligible/available and the job's policy allows it;
  - reconciliation (`src/recovery/`) — what happens to an attempt across a Controller/Agent
    restart or disconnect;
  - ops (`src/ops/`) — backup/restore validation, observability report shape;
  - SQLite storage (`src/storage/`) — migrations, the `jobs`/`job_attempts`/`job_events`/
    `artifacts`/`agents` tables.

- **`apps/agent/`** — a worker process, one per machine that should actually run jobs. Owns:
  - the Controller connection (`src/connection/client.ts`) — pairing, TLS fingerprint pinning,
    heartbeats, typed message dispatch;
  - the executor (`src/executor/`) — attempt lifecycle: materialize the snapshot, spawn the
    script via the shared `packages/executor` adapters, stream logs, collect artifacts, clean up;
  - recovery (`src/recovery/`) — attempt metadata persistence, disk-pressure admission, lease
    self-termination for destructive/hardware jobs;
  - the build cache (`src/build-cache/`) — named caches (ccache/sccache/npm/pnpm/pip), isolated by
    toolchain fingerprint + OS/arch + project identity;
  - the repo mirror (`src/repos/`) — a reusable bare Git mirror per repository, so a `git_overlay`
    job transfers a diff against a cached base commit instead of the whole repo;
  - Docker cleanup (`src/docker/`) — label-scoped removal of containers/networks/volumes tied to
    one attempt, never a global prune.

- **`apps/cli/`** — the `rbo` executable operators and scripts use: `controller init/fingerprint/
  restore`, `agent approve/revoke/probe/install/status/start/stop/uninstall`, `doctor`, `submit/
  logs/cancel`. Talks to the Controller over the same loopback HTTP admin/tool API the stdio proxy
  uses — never touches the database or security modules directly.

- **`apps/mcp-stdio/`** — a thin stdio↔HTTP proxy binary (`rbo-mcp-stdio`) for AI clients that only
  speak stdio MCP. Streamable-HTTP-capable clients can skip it and hit the Controller directly.

- **`packages/protocol/`** — the single source of truth for every wire contract: the canonical
  `JobRequest` Zod schema, the MCP tool registry, and every Controller↔Agent WebSocket message
  schema (lease offer/accept, prepare_source, run_job, log_chunk, artifact_manifest, …). Both
  Controller and Agent import from here — there is no second, parallel schema anywhere.

- **`packages/snapshot/`** — capture and materialization for both payload modes: `full` (the
  entire filtered dirty tree, tar+zstd archived) and `git_overlay` (a diff against a Git base
  commit, for repos with a reusable Agent-side mirror). Shared secret-denylist, symlink-escape,
  and submodule/LFS policy live here, used identically by both modes.

- **`packages/executor/`** — the platform-independent process-lifecycle adapters (spawn, stream
  logs, enforce timeout/completion-policy, collect artifacts, cleanup) used by *both* Controller-
  local execution and Agent-remote execution, so the two never diverge on how a script actually
  runs.

- **`packages/shared/`** — errors (`RboError`/`ErrorCategorySchema`), ID generation, hashing, path/
  containment helpers, Ed25519 crypto + Controller identity (TLS cert + signing keys), packaging
  helpers, and backup/restore validation (`validateRestore`) — anything both an app and the CLI
  need, so app-to-app source imports are never necessary (this repo's per-app `tsconfig.rootDir`
  doesn't allow them anyway).

- **`native/windows-executor/`** — a small Rust binary using Win32 Job Objects for real process-
  tree containment on Windows (kill-on-close semantics: cancel/crash always takes the whole
  descendant tree with it). Talks to the Node adapter in `packages/executor` over a length-
  prefixed binary frame protocol on stdout (not line-delimited JSON — see the protocol doc below
  for why). This is genuinely Windows-only today; macOS/Linux Agents run scripts without an
  equivalent containment layer (see the README's Known limitations).

## Request flow (the one path worth memorizing)

1. AI client calls `job_submit` (MCP tool) with a `JobRequest` (source root, script, risk level,
   artifact globs, …).
2. Controller captures a snapshot of that source root — either a full filtered archive or a
   `git_overlay` diff against a cached base commit — and re-validates nothing changed mid-capture
   (`workspace_changed` if it did; the whole point is an *exact*, race-free snapshot).
3. `safe`/`normal` jobs queue immediately; `destructive`/`hardware` jobs come back
   `awaiting_confirmation` with a short-lived signed token that `job_confirm` must present before
   anything runs — a deliberate, non-bypassable gate, not a UI nicety.
4. The scheduler either picks an eligible, capable Agent (hard-filtered, then scored) or falls back
   to local execution if policy allows it and none is available.
5. Remote path: Controller leases the attempt to the Agent (fenced by `attempt_id`/`lease_id`/
   `lease_epoch` on every subsequent message), sends the snapshot/overlay, the Agent materializes
   it into its own isolated workspace and runs the script through the shared executor.
6. Logs stream back over a disk-backed, sequenced, acknowledged spool (survives a reconnect without
   duplicating or losing a byte); artifacts are hash-verified and uploaded on completion.
7. The AI client polls `job_wait`/`job_logs`, then `job_artifacts` + `artifact_materialize` to pull
   a result file back into an allowed destination on its own machine.

## Where the real spec lives

This document is an orientation map, not the contract. Before changing wire schemas, the snapshot
algorithm, the scheduler formula, or the reconciliation state machine, read:

- [`remote-build-orchestrator-design.md`](../../remote-build-orchestrator-design.md) — the
  canonical, section-numbered design spec (§ references throughout the codebase point here).
- [`PHASE_HANDOFFS.md`](../../PHASE_HANDOFFS.md) — the phase-by-phase implementation history:
  what each phase's scope was, the decisions that got locked in, and known gaps left for later.
- [`AGENTS.md`](../../AGENTS.md) / `CLAUDE.md` — working conventions for an AI agent (or human)
  modifying this repo: canonical commands, the final `pnpm format && pnpm verify` gate, and rules
  about not weakening wire contracts or security/path checks for convenience.
- [`docs/dev/release-builds.md`](./release-builds.md) — how to cut and package a release once
  you're ready to ship a change.
