# Phase 6 — Long-running Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interrupted remote Agent↔Controller connections recoverable via attempt-scoped disk log spool, `log_ack`/replay, and orphan/adoption reconciliation — without weakening lease fencing or re-running side-effecting scripts on reconnect.

**Architecture:** Agent writes redacted log bytes to disk first (`{stateDir}/logs/<attempt-id>/` with `ack.json`), then pushes through a bounded in-memory network queue. Controller appends idempotently by sequence, persists, and replies `log_ack`. Disconnect no longer immediately fails attempts: grace → `orphaned` → adopt (same fenced tuple) or `lost` / stale cleanup. Separate recovery coordinators own restart/orphan decisions (not ad-hoc WS callbacks).

**Tech Stack:** TypeScript (strict), Zod (`@rbo/protocol`), better-sqlite3 migrations, Vitest, existing WS control plane + `@rbo/executor` log helpers.

## Global Constraints

- Repo: `C:/projects/gemslibe/rm-builder`; design doc `remote-build-orchestrator-design.md` is normative.
- TDD: failing test first (real RED), then minimal code, GREEN. Never write the test after the code.
- Zod schemas in `packages/protocol` / `packages/snapshot` are the only wire contract source — no local copies in `apps/*`.
- New persisted structure → new migration version in `apps/controller/src/storage/migrations.ts` (append to `MIGRATIONS[]`; never edit existing up/down).
- Error categories only via `packages/shared/src/errors.ts` (`ErrorCategorySchema`).
- Do not implement Phase 7 (QEMU/Docker caches) or Phase 8 (packaging).
- Do not weaken lease fencing: every inbound frame, spool replay, artifact upload/retry, cleanup ack, and disk cleanup decision must validate the fenced `(attempt_id, lease_id, lease_epoch)` tuple.
- Never silently discard unacknowledged output; spool-cap breach → terminal attempt with `log_spool_limit`.
- Never re-collect artifacts from a mutable workspace on resume; only re-upload manifest-declared, hash-verified objects for the same fenced attempt.
- Disk-pressure cleanup order: refuse new leases → expired artifacts → old terminal workspaces → old terminal logs/spools → inactive repo caches. Never remove an active attempt, its unacked spool, or a mirror held by an active job.
- Final gate: `pnpm format` then `pnpm verify` (exit 0).
- Commits: only if the human explicitly asked in-session; otherwise leave staging to the user (AGENTS.md). Report status via `.superpowers/sdd/` files.
- Keep diffs focused; no drive-by refactors.

## File map

| Area | Create / Modify |
|------|-----------------|
| Protocol | Modify `packages/protocol/src/messages.ts`; test `packages/protocol/test/protocol-phase6.test.ts` |
| Errors | Modify `packages/shared/src/errors.ts` (`log_spool_limit`) |
| Spool | Create `packages/executor/src/spool.ts`; export via `packages/executor/src/index.ts`; test `packages/executor/test/spool.test.ts` |
| Controller DB | Append migration v3 in `apps/controller/src/storage/migrations.ts`; extend lifecycle helpers |
| Controller recovery | Create `apps/controller/src/recovery/coordinator.ts`; wire from `main.ts` / WS server |
| Controller remote | Modify `apps/controller/src/execution/remote-execution.ts` (ack, disconnect grace, orphan/adopt, lost) |
| Controller WS | Modify `apps/controller/src/websocket/server.ts` (`log_ack` outbound, recovery inbound) |
| Controller config | Modify `apps/controller/src/config.ts` (grace / orphan / spool-related keys documented) |
| Agent spool/send | Modify `apps/agent/src/executor/index.ts`; create `apps/agent/src/recovery/coordinator.ts`, `apps/agent/src/logs/spool-sender.ts` |
| Agent metadata | Create attempt metadata under `{stateDir}/attempts/<id>/metadata.json` + spool dir `{stateDir}/logs/<id>/` |
| Agent config | Modify `apps/agent/src/config.ts` |
| Tests | `apps/controller/test/log-spool.test.ts`, `reconnect-reconcile.test.ts`, `disk-pressure.test.ts`, extend remote-execution / agent tests |

---

### Task 1: Typed schemas, error category, Controller migration

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/test/protocol-phase6.test.ts`
- Modify: `apps/controller/src/storage/migrations.ts` (append version 3)
- Modify: `apps/controller/src/jobs/lifecycle.ts` (helpers for new columns / orphaned state)
- Create: `apps/controller/test/migration-v3.test.ts` (or extend existing migration test if present)

**Interfaces:**
- Consumes: existing `JOB_SCOPED_MESSAGE_TYPES`, `WireMessageEnvelopeSchema`, `job_attempts` table
- Produces:
  - `log_spool_limit` in `ErrorCategorySchema`
  - `LogAckPayloadSchema` / `LogAckPayload`
  - `RecoveryReportPayloadSchema` / `RecoveryReportPayload` (Agent → Controller)
  - `ReconcileDecisionPayloadSchema` / `ReconcileDecisionPayload` (Controller → Agent)
  - Message types: Agent `recovery_report`; Controller `log_ack`, `reconcile_decision`
  - Migration v3 columns on `job_attempts`: `log_acked_sequence INTEGER NOT NULL DEFAULT 0`, `orphaned_at TEXT`, `process_identity TEXT`, `last_reconcile_at TEXT`
  - Attempt `state` may be `'orphaned'`; job/attempt `outcome` may be `'lost'` (ensure CHECK/app code accepts it — SQLite has no enum CHECK on state today)

- [ ] **Step 1: Write failing protocol tests**

Create `packages/protocol/test/protocol-phase6.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  ControllerMessageTypeSchema,
  AgentMessageTypeSchema,
  JOB_SCOPED_MESSAGE_TYPES,
  LogAckPayloadSchema,
  RecoveryReportPayloadSchema,
  ReconcileDecisionPayloadSchema,
  WireMessageEnvelopeSchema,
} from '../src/messages.js';
import { ErrorCategorySchema } from '@rbo/shared';

describe('Phase 6 Protocol Schemas', () => {
  it('includes log_spool_limit error category', () => {
    expect(ErrorCategorySchema.options).toContain('log_spool_limit');
  });

  it('adds log_ack and reconcile_decision to controller messages', () => {
    expect(ControllerMessageTypeSchema.options).toContain('log_ack');
    expect(ControllerMessageTypeSchema.options).toContain('reconcile_decision');
  });

  it('adds recovery_report to agent messages', () => {
    expect(AgentMessageTypeSchema.options).toContain('recovery_report');
  });

  it('marks log_ack, recovery_report, reconcile_decision as job-scoped', () => {
    for (const t of ['log_ack', 'recovery_report', 'reconcile_decision']) {
      expect(JOB_SCOPED_MESSAGE_TYPES.has(t)).toBe(true);
    }
  });

  it('validates log_ack payload', () => {
    const ok = LogAckPayloadSchema.safeParse({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      sequence: 42,
    });
    expect(ok.success).toBe(true);
    expect(LogAckPayloadSchema.safeParse({ attempt_id: 'att_1', lease_id: 'l', lease_epoch: 1, sequence: 0 }).success).toBe(false);
  });

  it('validates recovery_report statuses', () => {
    const ok = RecoveryReportPayloadSchema.safeParse({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      status: 'running',
      process_identity: 'pid:1234:started:2026-07-20T00:00:00.000Z',
      last_sent_sequence: 10,
      last_acked_sequence: 8,
      artifact_upload_pending: false,
    });
    expect(ok.success).toBe(true);
    for (const status of ['running', 'completed_awaiting_upload', 'orphaned'] as const) {
      expect(
        RecoveryReportPayloadSchema.safeParse({
          attempt_id: 'att_1',
          lease_id: 'lease_1',
          lease_epoch: 1,
          status,
          process_identity: 'x',
          last_sent_sequence: 0,
          last_acked_sequence: 0,
          artifact_upload_pending: false,
        }).success,
      ).toBe(true);
    }
    expect(
      RecoveryReportPayloadSchema.safeParse({
        attempt_id: 'att_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        status: 'mystery',
        process_identity: 'x',
        last_sent_sequence: 0,
        last_acked_sequence: 0,
        artifact_upload_pending: false,
      }).success,
    ).toBe(false);
  });

  it('validates reconcile_decision actions', () => {
    expect(
      ReconcileDecisionPayloadSchema.safeParse({
        attempt_id: 'att_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        action: 'adopt',
        resume_from_sequence: 8,
      }).success,
    ).toBe(true);
    expect(
      ReconcileDecisionPayloadSchema.safeParse({
        attempt_id: 'att_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        action: 'terminate_stale',
        reason: 'newer_epoch',
      }).success,
    ).toBe(true);
    expect(
      ReconcileDecisionPayloadSchema.safeParse({
        attempt_id: 'att_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        action: 'noop',
      }).success,
    ).toBe(false);
  });

  it('rejects job-scoped envelope missing lease fields for log_ack', () => {
    const bad = WireMessageEnvelopeSchema.safeParse({
      protocol: 1,
      type: 'log_ack',
      message_id: 'msg_1',
      sent_at: new Date().toISOString(),
      attempt_id: null,
      lease_id: null,
      lease_epoch: null,
      payload: {},
    });
    expect(bad.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect RED**

Run: `pnpm exec vitest run packages/protocol/test/protocol-phase6.test.ts`
Expected: FAIL (schemas / categories missing).

- [ ] **Step 3: Implement schemas + error category**

In `packages/shared/src/errors.ts`, add `'log_spool_limit'` before `'internal'`.

In `packages/protocol/src/messages.ts`:

```typescript
// AgentMessageTypeSchema — add:
'recovery_report',

// ControllerMessageTypeSchema — add:
'log_ack',
'reconcile_decision',

// JOB_SCOPED_MESSAGE_TYPES — add:
'log_ack',
'recovery_report',
'reconcile_decision',

export const LogAckPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  sequence: z.number().int().positive(),
});

export const RecoveryReportStatusSchema = z.enum([
  'running',
  'completed_awaiting_upload',
  'orphaned',
]);

export const RecoveryReportPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  status: RecoveryReportStatusSchema,
  process_identity: z.string().min(1),
  last_sent_sequence: z.number().int().nonnegative(),
  last_acked_sequence: z.number().int().nonnegative(),
  artifact_upload_pending: z.boolean(),
});

export const ReconcileDecisionPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  action: z.enum(['adopt', 'terminate_stale']),
  resume_from_sequence: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export type LogAckPayload = z.infer<typeof LogAckPayloadSchema>;
export type RecoveryReportPayload = z.infer<typeof RecoveryReportPayloadSchema>;
export type ReconcileDecisionPayload = z.infer<typeof ReconcileDecisionPayloadSchema>;
```

- [ ] **Step 4: Migration v3**

Append to `MIGRATIONS`:

```typescript
{
  version: 3,
  name: 'phase6-attempt-recovery',
  up: `
ALTER TABLE job_attempts ADD COLUMN log_acked_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_attempts ADD COLUMN orphaned_at TEXT;
ALTER TABLE job_attempts ADD COLUMN process_identity TEXT;
ALTER TABLE job_attempts ADD COLUMN last_reconcile_at TEXT;
`,
  down: `
-- SQLite cannot DROP COLUMN portably in all versions used here; leave no-op or recreate if project already has a down pattern.
`,
}
```

Match the project's existing `down` style for v2. Extend lifecycle `updateAttempt` to allow setting the new fields. Document that `state='orphaned'` and `outcome='lost'` are valid Phase 6 values (no schema CHECK blocks them today).

Write a small test that opens a temp DB, applies migrations through v3, and asserts the new columns exist via `PRAGMA table_info(job_attempts)`.

- [ ] **Step 5: Run tests — expect GREEN**

Run: `pnpm exec vitest run packages/protocol/test/protocol-phase6.test.ts apps/controller/test/migration-v3.test.ts`
Expected: PASS.

- [ ] **Step 6: Report**

Write `.superpowers/sdd/task-1-report.md` with status DONE, files changed, test commands/output. Do not commit unless the human asked.

---

### Task 2: Agent disk spool, bounded sender, Controller idempotent append + `log_ack`

**Files:**
- Create: `packages/executor/src/spool.ts`
- Modify: `packages/executor/src/index.ts`, `packages/executor/src/logs.ts` (reuse paths; spool owns sequence index)
- Create: `packages/executor/test/spool.test.ts`
- Create: `apps/agent/src/logs/spool-sender.ts`
- Modify: `apps/agent/src/executor/index.ts` (disk-first + sender; stop fire-and-forget live-only send)
- Modify: `apps/agent/src/config.ts` — `RBO_LOG_SPOOL_MAX_BYTES` (default e.g. `536870912`), `RBO_LOG_SEND_QUEUE_MAX` (default e.g. `64`)
- Modify: `apps/controller/src/execution/remote-execution.ts` — `handleRemoteLogChunk` idempotent + send ack
- Modify: `apps/controller/src/websocket/server.ts` — handle sending `log_ack` (via connectedAgents send helper)
- Create: `apps/controller/test/log-spool.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; `ensureAttemptLogs`; `appendLogChunk`
- Produces:
  - `AttemptSpool` API:
    - `openAttemptSpool(spoolDir): Promise<AttemptSpool>`
    - `appendChunk(spool, stream, bytes): Promise<{ sequence: number }>` — assigns next sequence, appends to stream file **and** appends a line to `chunks.jsonl` `{sequence,stream,offset,length}` (or equivalent index) so replay can re-read exact chunks without splitting UTF-8 incorrectly
    - `readAck(spool): Promise<number>` / `writeAck(spool, sequence): Promise<void>` — atomic replace of `ack.json` via temp+rename
    - `iterUnacked(spool, afterSequence): AsyncIterable<{sequence,stream,bytes}>`
    - `totalBytes(spool): Promise<number>`
  - `SpoolSender` on Agent: bounded queue; `enqueue(chunk)`; `onAck(sequence)`; `startReplay()`; never blocks the job process; when spool bytes ≥ max → fail attempt with `log_spool_limit`
  - Controller: store highest contiguous acked sequence in `job_attempts.log_acked_sequence`; ignore duplicate sequence (still ack); reject gap? Prefer: accept only `sequence === log_acked_sequence + 1` for new append; if `sequence <= log_acked_sequence` → ack again without append; if `sequence > log_acked_sequence + 1` → ignore/log (agent must replay in order)

**Spool layout (canonical):**

```text
{stateDir}/logs/<attempt-id>/
  stdout.log
  stderr.log
  events.jsonl
  chunks.jsonl    # one JSON object per chunk: {sequence,stream,byte_offset,byte_length}
  ack.json        # {"acked_sequence": N}
```

Agent workspace logs under `workspaces/<id>/logs` may remain for local debugging OR be redirected to the spool dir via the same `AttemptLogPaths` — prefer **one** directory: pass spool dir into `ensureAttemptLogs` so job script env `RBO_LOG_DIR` points at the spool.

- [ ] **Step 1: Write failing spool unit tests** (`packages/executor/test/spool.test.ts`)

Cover: sequence allocation starts at 1; disk append before return; `writeAck` atomic; `iterUnacked` returns only `sequence > acked` in order; duplicate read after ack empty; `totalBytes` grows.

- [ ] **Step 2: Implement `spool.ts` + export; GREEN unit tests**

- [ ] **Step 3: Write failing Controller idempotent test**

In `apps/controller/test/log-spool.test.ts` (unit-level with temp dataDir + in-memory/db fixture patterned after `remote-execution.test.ts`):

1. First `log_chunk` sequence=1 appends bytes and would emit ack sequence=1.
2. Replay same sequence=1 does not duplicate file bytes; ack still 1.
3. sequence=3 before 2 is ignored (no append).
4. `job_logs` cursor reads durable bytes once.

- [ ] **Step 4: Implement Controller `handleRemoteLogChunk` + `log_ack` send**

Pseudocode:

```typescript
const prev = attempt.log_acked_sequence ?? 0;
if (payload.sequence <= prev) {
  sendLogAck(...); // duplicate ack
  return;
}
if (payload.sequence !== prev + 1) {
  // out of order — do not append
  return;
}
await appendLogChunk(...);
updateAttempt({ log_acked_sequence: payload.sequence });
sendLogAck(agent, { attempt_id, lease_id, lease_epoch, sequence: payload.sequence });
```

Wire Agent handler for inbound `log_ack` → `spoolSender.onAck` + `writeAck`.

- [ ] **Step 5: Replace Agent live-only send with spool + bounded sender**

On each stdout/stderr data: redact → `appendChunk` (await) → `sender.enqueue`. Sender drains WS when open; on reconnect (Task 3 will call `startReplay`). If `totalBytes > max` → kill job / `job_exit` with `failure_category: 'log_spool_limit'`.

- [ ] **Step 6: GREEN targeted tests**

Run: `pnpm exec vitest run packages/executor/test/spool.test.ts apps/controller/test/log-spool.test.ts`
Also re-run any agent cancel/log tests that mock `appendLogChunk`.

- [ ] **Step 7: Report** → `.superpowers/sdd/task-2-report.md`

---

### Task 3: Recovery coordinators — disconnect grace, orphan, adopt, Controller/Agent restart

**Files:**
- Create: `apps/controller/src/recovery/coordinator.ts`
- Create: `apps/agent/src/recovery/coordinator.ts`
- Create: `apps/agent/src/recovery/attempt-metadata.ts` — persist `{attempt_id,job_id,lease_id,lease_epoch,process_identity,status,workspace_path,spool_dir,...}` atomically under `{stateDir}/attempts/<attempt-id>/metadata.json`
- Modify: `apps/controller/src/websocket/server.ts` — on close call coordinator (not immediate fail-all); handle `recovery_report`
- Modify: `apps/controller/src/execution/remote-execution.ts` — remove/replace immediate `handleAgentDisconnect` terminal failure; add adopt/terminate_stale
- Modify: `apps/agent/src/connection/client.ts` — stop `abandonOnDisconnect` kill-for-all; keep process for safe/normal through grace; still persist spool
- Modify: `apps/agent/src/config.ts` / `apps/controller/src/config.ts`:
  - `RBO_DISCONNECT_GRACE_SECONDS` (default `60`)
  - `RBO_ORPHAN_TIMEOUT_SECONDS` (default `300`)
  - `RBO_RECONCILE_DEADLINE_SECONDS` (default `120`) — Controller restart wait
- Modify: destructive/hardware detection from job request risk class (existing schema field — use it)
- Create: `apps/controller/test/reconnect-reconcile.test.ts`

**Rules (exact):**

1. Controller restart: load non-terminal attempts; keep lease tuples + `log_acked_sequence`; wait for authenticated Agent `recovery_report`; if none by deadline → `outcome=lost`, `state=completed`.
2. Agent restart: scan `{stateDir}/attempts/*/metadata.json` + live processes; emit `recovery_report` per attempt (`running` | `completed_awaiting_upload` | `orphaned`); replay unacked logs only after `reconcile_decision.action=adopt`.
3. Adopt only when Agent id, attempt id, lease_id, lease_epoch, and `process_identity` all match Controller record. Else `terminate_stale` — Agent kills process, cleans, rejects further frames.
4. Disconnect: safe/normal continue through grace; after grace → Controller `state=orphaned` (`orphaned_at=now`). Destructive/hardware: self-terminate at lease expiry without needing Controller (Task 4 also covers lease timer).
5. Fence every frame including replay.

- [ ] **Step 1: Failing reconcile tests** covering:
  - disconnect during safe job → grace → reconnect same tuple → adopt → ordered non-duplicated logs via `job_logs`
  - replacement attempt / newer epoch → `terminate_stale`; stale `log_chunk` / artifact rejected
  - disconnect before script start → no duplicate side effects; attempt lost or requeued per design (pre-`job_started`: prefer fail/lost without rerun in Phase 6 — document choice matching §18.2 "queued" only if scheduler retry exists; Phase 3 forbade auto-retry → mark `lost` or `failed`/`agent_lost`, do **not** spawn new attempt automatically)

- [ ] **Step 2: Implement Controller `RecoveryCoordinator`**
  - `onAgentDisconnect(agentId)`
  - `onGraceElapsed(attemptId)`
  - `onOrphanTimeout(attemptId)` → `lost`
  - `onRecoveryReport(agentId, payload)` → adopt or terminate_stale
  - `onControllerStartup()` → arm reconcile deadlines

- [ ] **Step 3: Implement Agent `RecoveryCoordinator` + metadata persistence**
  - Write metadata on lease accept / job_started (include pid-based `process_identity`)
  - On startup scan + report
  - Handle `reconcile_decision`

- [ ] **Step 4: Wire WS + change disconnect behavior**

- [ ] **Step 5: GREEN tests + report** → `.superpowers/sdd/task-3-report.md`

---

### Task 4: Lease-expiry self-termination, artifact upload resume, disk-pressure admission

**Files:**
- Modify: `apps/agent/src/executor/index.ts` — local lease deadline timer; destructive/hardware kill at expiry even if disconnected
- Modify: artifact upload path on Agent + Controller grant retry — resume upload of declared hash-verified files only
- Create: `apps/agent/src/recovery/disk-pressure.ts`
- Modify: heartbeat/capabilities to publish disk/capacity fields (extend existing capabilities JSON; keep backward-compatible additive fields)
- Modify: `apps/agent/src/config.ts` — `RBO_DISK_MIN_FREE_BYTES`, reuse repo-cache retention knobs
- Create: `apps/controller/test/disk-pressure.test.ts` (and/or agent unit tests)
- Extend: `apps/controller/test/remote-execution.test.ts` / artifact tests for resume

**Behavior:**

1. Agent tracks `lease_deadline` from offer/renewals; on expiry for destructive/hardware → kill process tree, write terminal metadata, do not wait for Controller.
2. Artifact resume: if `completed_awaiting_upload`, on adopt re-send `artifact_manifest` / continue PUT only for missing objects; never re-glob workspace.
3. Disk pressure when free disk < threshold OR spool pressure:
   - stop accepting new leases (`lease_reject` / capability `accepting_jobs: false`)
   - delete expired artifacts → old terminal workspaces → old terminal spools → inactive repo caches (order fixed)
   - never touch active attempt spool/workspace/mirror

- [ ] **Step 1: Failing tests** for lease self-term (can fake clock / short TTL), artifact resume, disk-pressure order (temp dirs with markers).

- [ ] **Step 2: Implement** minimal code for each.

- [ ] **Step 3: GREEN + report** → `.superpowers/sdd/task-4-report.md`

---

### Task 5: Fault-injection integration suite + large-output / memory bound + final verify

**Files:**
- Create: `apps/controller/test/phase6-reliability.test.ts` (integration; pattern from `remote-execution.test.ts` / Phase 4 harness)
- Optionally gate 1 GiB test: `it.skipIf(!process.env.RBO_LARGE_LOG_TEST)` with smaller default streaming test asserting RSS / heap delta bound

**Required scenarios (all must exist):**

1. Disconnect before script start
2. Disconnect during safe job + reconnect replay; stdout/stderr/events ordered, no duplicates through `job_logs`
3. Replacement attempt rejects every stale frame and artifact
4. Real lease expiry → hardware/destructive job terminates without Controller
5. Controller restart mid-execution → cursors restored → adopt or `lost`
6. Agent restart → stale workspaces → idempotent cleanup after grace
7. Two attempts of one job never mix workspace/logs/acks/artifacts/cleanup (extend `packages/testing` harness if helpful — same file as §0 git fixtures policy)
8. Full spool + slow Controller + repeated reconnects → bounded memory + explicit `log_spool_limit` (not silent loss)
9. Large synthetic output: gated 1 GiB **or** streaming test with explicit byte/memory assertion

- [ ] **Step 1: Write failing integration tests** (scaffold harness, assert behaviors)

- [ ] **Step 2: Fix gaps revealed by integration (only Phase 6 scope)**

- [ ] **Step 3: Final gate**

```bash
pnpm format
pnpm verify
```

Expected: exit code 0.

- [ ] **Step 4: Phase completion report**

Write `.superpowers/sdd/progress.md` Phase 6 section + `.superpowers/sdd/phase-6-report.md` including:
- files changed
- tests added
- `pnpm verify` exit code
- PLATFORM-GAP grep list
- known limitations / borderline decisions
- residual risks

Do **not** start Phase 7.

---

## Spec coverage checklist

| Handoff requirement | Task |
|---------------------|------|
| `log_ack` + recovery schemas + migrations | 1 |
| Disk spool, sequence, bounded sender, replay, idempotent append | 2 |
| Restart coordinators, orphan/adoption | 3 |
| Lease self-term, artifact resume, disk-pressure | 4 |
| Fault-injection + 1 GiB/streaming memory test | 5 |
| Fence all frames / no silent discard / no side-effect rerun | 2–4 |
| Two attempts isolation | 5 (+ existing Phase 3 coverage) |

## Placeholder / consistency self-review

- No TBD steps; spool path pinned to `{stateDir}/logs/<attempt-id>/`.
- Pre-`job_started` disconnect: no auto-retry (aligns with Phase 3 decision).
- `log_spool_limit` added to shared errors once in Task 1.
- Contiguous ack semantics consistent across Tasks 2–3.
