# Architecture

This is the developer's map of RBO. It explains the main boundaries, the request lifecycle, and
where to look next. The code and tests document implementation details; the
[design specification](../../remote-build-orchestrator-design.md) is the canonical contract for
protocol and state-machine decisions.

If you only want to operate RBO, start with the [user guide](../user/getting-started.md).

## Mental model

RBO separates three concerns:

1. **The AI client asks for work.** It talks only to the Controller through MCP.
2. **The Controller decides and records.** It validates the request, captures source, persists
   state, and schedules an execution.
3. **An Agent executes.** It materializes an isolated workspace, runs the command, and returns logs
   and artifacts.

Local fallback uses the same snapshot and shared executor as a remote job. It changes where the
job runs, not the job model.

```text
AI client
    │ MCP
    ▼
Controller ───── SQLite
    │
    │ TLS WebSocket: leases, source, logs, artifacts
    ▼
Agent ───── isolated workspace ───── process executor
```

## Repository map

| Area | Responsibility | Good starting point |
| --- | --- | --- |
| `apps/controller/` | MCP/API, persistence, scheduling, snapshot coordination, recovery | `src/run.ts`, then the relevant folder |
| `apps/agent/` | pairing, capabilities, source materialization, execution, recovery | `src/run.ts` |
| `apps/cli/` | operator commands and the distributable bundle | `src/main.ts` |
| `apps/mcp-stdio/` | stdio-to-HTTP MCP bridge | `src/main.ts` |
| `packages/protocol/` | Zod schemas and wire messages | `src/schemas.ts` |
| `packages/snapshot/` | capture, overlay, archive, and materialization | `src/` plus nearby tests |
| `packages/executor/` | cross-platform process lifecycle and artifact collection | `src/` plus platform adapters |
| `packages/shared/` | shared errors, IDs, paths, crypto, and version constants | the named module under `src/` |
| `native/windows-executor/` | Windows Job Object containment helper | `src/main.rs` |
| `packages/testing/` | fixtures and shared test helpers | `src/` |

Start from the behavior's owning app, then follow imports into packages. Avoid app-to-app source
imports; shared behavior belongs in a package.

## Job lifecycle

The main path is:

1. `job_run` or `job_submit` validates a `JobRequest` from `packages/protocol`.
2. The Controller captures the current project as an immutable full snapshot or Git overlay.
3. Risky jobs pause for explicit confirmation.
4. The scheduler filters Agents by capacity and requirements, then chooses a destination.
5. The Controller creates a fenced attempt and leases it to the selected Agent.
6. The Agent materializes the source and runs the command through `packages/executor`.
7. Sequenced logs and hash-verified artifacts return to the Controller.
8. MCP exposes the terminal result and allows approved artifact materialization.

Every meaningful transition is persisted. Reconciliation code decides what happens after a
Controller restart, Agent restart, expired lease, or lost connection.

## Boundaries that matter

- **Protocol:** `packages/protocol/` is the only source of truth for MCP and Controller-Agent
  messages. A contract change usually affects both apps and their tests.
- **Source isolation:** jobs run against captured content, never directly in the submitted
  checkout.
- **Execution parity:** local and remote paths share `packages/executor/`.
- **Fencing:** attempt, lease, and epoch identifiers prevent stale Agents from completing newer
  work.
- **Paths and artifacts:** allowlists and containment checks are security boundaries, not input
  conveniences.
- **Platform isolation:** Windows uses the native Job Object helper. Unix process handling is not
  an equivalent security sandbox.

## Where to look for details

| If you are changing… | Read first |
| --- | --- |
| MCP tools or wire messages | `packages/protocol/`, nearby tests, design spec §§13 and 20 |
| Snapshot or Git overlay behavior | `packages/snapshot/`, capture tests, design spec §§11–12 |
| Scheduling or queue policy | `apps/controller/src/scheduler/`, scheduler tests, design spec §19 |
| Leases, reconnects, or recovery | Controller and Agent `src/recovery/`, reliability tests |
| Process execution or cancellation | `packages/executor/` and `native/windows-executor/` |
| Pairing, identity, or path security | the owning `src/security/` code and threat-regression tests |
| Packaging and publishing | [Release guide](release-builds.md) |

Repository conventions and validation commands live in [AGENTS.md](../../AGENTS.md). Historical
plans are not architecture authority; prefer current code, tests, protocol schemas, and the design
specification in that order.
