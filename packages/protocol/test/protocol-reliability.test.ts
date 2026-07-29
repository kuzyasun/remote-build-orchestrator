import { ErrorCategorySchema } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import {
  AgentMessageTypeSchema,
  ControllerMessageTypeSchema,
  JOB_SCOPED_MESSAGE_TYPES,
  LogAckPayloadSchema,
  ReconcileDecisionPayloadSchema,
  RecoveryReportPayloadSchema,
  WireMessageEnvelopeSchema,
} from '../src/messages.js';

describe('Protocol schemas — reliability (log ack, recovery report, reconcile decision)', () => {
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
    expect(
      LogAckPayloadSchema.safeParse({
        attempt_id: 'att_1',
        lease_id: 'l',
        lease_epoch: 1,
        sequence: 0,
      }).success,
    ).toBe(false);
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
