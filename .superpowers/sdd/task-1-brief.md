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
  - `RecoveryReportPayloadSchema` / `RecoveryReportPayload` (Agent â†’ Controller)
  - `ReconcileDecisionPayloadSchema` / `ReconcileDecisionPayload` (Controller â†’ Agent)
  - Message types: Agent `recovery_report`; Controller `log_ack`, `reconcile_decision`
  - Migration v3 columns on `job_attempts`: `log_acked_sequence INTEGER NOT NULL DEFAULT 0`, `orphaned_at TEXT`, `process_identity TEXT`, `last_reconcile_at TEXT`
  - Attempt `state` may be `'orphaned'`; job/attempt `outcome` may be `'lost'` (ensure CHECK/app code accepts it â€” SQLite has no enum CHECK on state today)

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

- [ ] **Step 2: Run test â€” expect RED**

Run: `pnpm exec vitest run packages/protocol/test/protocol-phase6.test.ts`
Expected: FAIL (schemas / categories missing).

- [ ] **Step 3: Implement schemas + error category**

In `packages/shared/src/errors.ts`, add `'log_spool_limit'` before `'internal'`.

In `packages/protocol/src/messages.ts`:

```typescript
// AgentMessageTypeSchema â€” add:
'recovery_report',

// ControllerMessageTypeSchema â€” add:
'log_ack',
'reconcile_decision',

// JOB_SCOPED_MESSAGE_TYPES â€” add:
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

- [ ] **Step 5: Run tests â€” expect GREEN**

Run: `pnpm exec vitest run packages/protocol/test/protocol-phase6.test.ts apps/controller/test/migration-v3.test.ts`
Expected: PASS.

- [ ] **Step 6: Report**

Write `.superpowers/sdd/task-1-report.md` with status DONE, files changed, test commands/output. Do not commit unless the human asked.

---
