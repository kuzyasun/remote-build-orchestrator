# Task 2 Report — Agent disk spool, bounded sender, Controller idempotent append + `log_ack`

**Status:** DONE  
**Date:** 2026-07-21  
**Commits:** none (per instructions)

## Summary

Implemented attempt-scoped disk log spool (`AttemptSpool`), Agent bounded `SpoolSender` (disk-first, never blocks the job process), and Controller contiguous-sequence idempotent `log_chunk` handling with outbound `log_ack`. No reconnect/orphan/adoption coordinators (Task 3).

## TDD Evidence

### RED — Spool unit tests (Step 1)

Command:
```bash
pnpm exec vitest run packages/executor/test/spool.test.ts
```

Result: **FAIL** — `Cannot find module '../src/spool.js'` (feature missing).

### GREEN — Spool implementation (Step 2)

Same command after `packages/executor/src/spool.ts`: **6 passed**.

### RED — Controller idempotent tests (Step 3)

Command:
```bash
pnpm exec vitest run apps/controller/test/log-spool.test.ts
```

Result: **FAIL** — `log_acked_sequence` stayed `0` (no ack / no idempotent gate). Fixture lease deadline corrected first so failure was feature-missing, not expired-lease.

### GREEN — Controller + Agent wire (Steps 4–6)

Same controller test: **1 passed**. Combined targeted:
```bash
pnpm exec vitest run packages/executor/test/spool.test.ts apps/controller/test/log-spool.test.ts apps/agent/test/cancel-signal.test.ts
```
**9 passed** (plus worktree duplicate of cancel-signal before exclude).

Final gate:
```bash
pnpm format
pnpm verify
```
Exit code **0** (lint, build, unit tests, rust:verify).

## Files Changed

| File | Change |
|------|--------|
| `packages/executor/src/spool.ts` | **Created** — `openAttemptSpool`, `appendChunk`, `readAck`/`writeAck`, `iterUnacked`, `totalBytes` |
| `packages/executor/src/index.ts` | Export spool API |
| `packages/executor/test/spool.test.ts` | **Created** — sequence, disk-first, atomic ack, iterUnacked, totalBytes, resume |
| `apps/controller/src/execution/remote-execution.ts` | Idempotent `handleRemoteLogChunk` + `log_ack` via `sendWsFrame`; SELECT/`AttemptLeaseRow` include `log_acked_sequence`; `updateAttempt` |
| `apps/controller/test/log-spool.test.ts` | **Created** — append/ack, duplicate, gap, `readLogsFromCursor` |
| `apps/agent/src/logs/spool-sender.ts` | **Created** — bounded queue, `enqueue`/`onAck`/`startReplay` |
| `apps/agent/src/executor/index.ts` | Disk-first spool at `{stateDir}/logs/<id>/`; sender; `handleLogAck`; `log_spool_limit` terminal |
| `apps/agent/src/config.ts` | `RBO_LOG_SPOOL_MAX_BYTES` (default 512MiB), `RBO_LOG_SEND_QUEUE_MAX` (default 64) |
| `apps/agent/src/connection/client.ts` | Inbound `log_ack` → `handleLogAck`; pass spool config |
| `apps/agent/src/main.ts` | Pass spool config into connection |
| `apps/agent/test/cancel-signal.test.ts` | Mock spool APIs used by new path |
| `vitest.config.ts` | Exclude `**/.claude/**` so nested worktree tests do not pollute verify |

**Not modified:** `apps/controller/src/websocket/server.ts` — outbound `log_ack` is sent from `handleRemoteLogChunk` via existing `connectedAgents` + `sendWsFrame` (no new WS route needed). `packages/executor/src/logs.ts` reused as-is via `ensureAttemptLogs` inside the spool.

## Contiguous Ack Semantics (Controller)

| Condition | Behavior |
|-----------|----------|
| `sequence === prev + 1` | Append bytes, set `log_acked_sequence`, send `log_ack` |
| `sequence <= prev` | No append; re-send `log_ack` |
| `sequence > prev + 1` | No append; no ack (agent must replay in order) |

## Deliverables Checklist

- [x] `AttemptSpool` API with `chunks.jsonl` index `{sequence,stream,byte_offset,byte_length}` and atomic `ack.json`
- [x] Spool layout under `{stateDir}/logs/<attempt-id>/` (Agent); Controller continues `attemptLogDir`
- [x] `SpoolSender` bounded queue; disk-first append before enqueue; `startReplay` for overflow/reconnect hook
- [x] Controller idempotent append + `log_ack`
- [x] Agent `log_ack` handler → `writeAck` + `sender.onAck`
- [x] Spool cap → kill + `failure_category: 'log_spool_limit'`
- [x] No Task 3 reconnect/orphan/adoption coordinators

## Self-Review

1. **Disk-first** — stdout/stderr path awaits `appendChunk` on a serialized write chain before `sender.enqueue`; fire-and-forget live-only `sendFrame` removed.
2. **Lease fencing** — Controller still validates fenced lease + agent + state before ack/append; Agent `handleLogAck` checks active spool lease tuple.
3. **UTF-8 chunk boundaries** — Replay reads exact byte ranges from `chunks.jsonl`, not line-split stream files.
4. **Queue overflow** — Drops from memory only; sets `needsReplay` and reloads from disk when capacity frees after ack (in addition to Task 3 `startReplay`).
5. **Scope** — No orphan grace, recovery_report, or reconcile_decision handling.
6. **Verify hygiene** — Excluded `.claude/**` from Vitest after nested worktree fixtures failed unrelated git-harness assertions during full `pnpm test`.

## Concerns

- `websocket/server.ts` unchanged by design (ack send lives in remote-execution). Call out if reviewers expected an explicit server helper.
- Full reconnect orchestration that *calls* `startReplay` on WS re-auth is intentionally Task 3; within a live session, overflow recovery uses `needsReplay`.

## Test Commands

```bash
pnpm exec vitest run packages/executor/test/spool.test.ts apps/controller/test/log-spool.test.ts
pnpm format
pnpm verify
```
