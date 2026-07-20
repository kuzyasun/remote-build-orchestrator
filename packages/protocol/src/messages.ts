import { z } from 'zod';

// --- Agent → Controller (§20.3) ---

export const AgentMessageTypeSchema = z.enum([
  'hello',
  'pairing_request',
  'capabilities',
  'heartbeat',
  'lease_accept',
  'lease_reject',
  'source_need',
  'source_ready',
  'job_started',
  'log_chunk',
  'job_exit',
  'artifact_manifest',
  'cleanup_complete',
  'agent_error',
]);

// --- Controller → Agent (§20.4) ---

export const ControllerMessageTypeSchema = z.enum([
  'hello_ack',
  'pairing_challenge',
  'lease_offer',
  'prepare_source',
  'snapshot_download',
  'bundle_download',
  'run_job',
  'cancel_job',
  'pause',
  'resume',
  'refresh_capabilities',
  'shutdown',
]);

/** All wire message types — both directions */
export const ProtocolMessageTypeSchema = z.enum([
  ...AgentMessageTypeSchema.options,
  ...ControllerMessageTypeSchema.options,
]);

// --- Wire envelope (§20.2) ---

/** Message types that must carry attempt_id, lease_id and lease_epoch (§20.2). */
export const JOB_SCOPED_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'lease_offer',
  'lease_accept',
  'lease_reject',
  'prepare_source',
  'snapshot_download',
  'bundle_download',
  'run_job',
  'cancel_job',
  'source_need',
  'source_ready',
  'job_started',
  'log_chunk',
  'job_exit',
  'artifact_manifest',
  'cleanup_complete',
]);

export const WireMessageEnvelopeSchema = z
  .object({
    protocol: z.number().int().positive(),
    type: ProtocolMessageTypeSchema,
    message_id: z.string(),
    sent_at: z.string(),
    attempt_id: z.string().nullable(),
    lease_id: z.string().nullable(),
    lease_epoch: z.number().nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((msg, ctx) => {
    if (JOB_SCOPED_MESSAGE_TYPES.has(msg.type)) {
      if (msg.attempt_id === null || msg.lease_id === null || msg.lease_epoch === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `job-scoped message '${msg.type}' requires attempt_id, lease_id and lease_epoch (§20.2)`,
        });
      }
    }
  });

export type WireMessageEnvelope = z.infer<typeof WireMessageEnvelopeSchema>;
