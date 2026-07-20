import { z } from 'zod';
import {
  ErrorCategorySchema,
  JobOutcomeSchema,
  JobRequestSchema,
  ToolchainProfileSchema,
} from './schemas.js';

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
  'artifact_upload_grant',
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
  'artifact_upload_grant',
  'cleanup_complete',
]);

// --- Typed Job-Scoped Message Payloads (§20.2 - §20.4, §35 Phase 4) ---

export const LeaseOfferPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  /** Controller-assigned job id — injected as RBO_JOB_ID on the Agent. */
  job_id: z.string().min(1),
  job_request: JobRequestSchema,
  snapshot_metadata: z.object({
    snapshot_id: z.string().min(1),
    content_id: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  }),
  selected_toolchain_profiles: z.array(ToolchainProfileSchema).optional(),
  lease_ttl_seconds: z.number().positive(),
});

export const LeaseAcceptPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
});

export const LeaseRejectPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  reason: z.string().min(1),
});

/** Phase 5 source_need reasons — exact enum, never free-form. */
export const SourceNeedReasonSchema = z.enum([
  'base_present',
  'base_commit_missing',
  'bundle_required',
  'full_snapshot_required',
  'repo_fetch_failed',
]);

export type SourceNeedReason = z.infer<typeof SourceNeedReasonSchema>;

const DataTransferDescriptorSchema = z.object({
  download_url: z.string().min(1),
  data_token: z.string().min(1),
  expected_size_bytes: z.number().int().nonnegative(),
  expected_sha256: z.string().min(1),
});

export const PrepareSourceRepoSchema = z.object({
  url: z.string().min(1),
  canonical_id: z.string().min(1),
  branch: z.string().nullable(),
  base_commit: z.string().min(1),
  fetch_refs: z.array(z.string().min(1)).default([]),
});

export const PrepareSourceFullPayloadSchema = z.object({
  source_mode: z.literal('full'),
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  download_url: z.string().min(1),
  data_token: z.string().min(1),
  expected_size_bytes: z.number().int().nonnegative(),
  expected_sha256: z.string().min(1),
  manifest: z.unknown().optional(),
});

export const PrepareSourceGitOverlayPayloadSchema = z.object({
  source_mode: z.literal('git_overlay'),
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  repo: PrepareSourceRepoSchema,
  overlay: DataTransferDescriptorSchema,
  manifest: z.unknown().optional(),
});

/** Discriminated by source_mode (§12.1 / Phase 5). */
export const PrepareSourcePayloadSchema = z.discriminatedUnion('source_mode', [
  PrepareSourceFullPayloadSchema,
  PrepareSourceGitOverlayPayloadSchema,
]);

export const SourceNeedPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  reason: SourceNeedReasonSchema,
  detail: z.string().optional(),
});

export const BundleDownloadPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  download_url: z.string().min(1),
  data_token: z.string().min(1),
  expected_size_bytes: z.number().int().nonnegative(),
  expected_sha256: z.string().min(1),
});

export const SourceReadyPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
});

export const RunJobPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
});

export const CancelJobPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  grace_seconds: z.number().positive().default(10),
  reason: z.string().optional(),
});

export const JobStartedPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  pid: z.number().int().positive().optional(),
});

export const LogChunkPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  stream: z.enum(['stdout', 'stderr']),
  sequence: z.number().int().positive(),
  bytes: z.string(),
});

export const JobExitPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  exit_code: z.number().int().nullable(),
  outcome: JobOutcomeSchema,
  failure_category: ErrorCategorySchema.optional(),
  failure_message: z.string().optional(),
});

/** Agent → Controller: declared artifacts before upload (§20.3). */
export const ArtifactManifestPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  artifacts: z.array(
    z.object({
      logical_name: z.string().min(1),
      path: z.string().min(1),
      size_bytes: z.number().int().nonnegative(),
      sha256: z.string().min(1),
    }),
  ),
});

/** Controller → Agent: per-artifact upload URL + short-lived token. */
export const ArtifactUploadGrantPayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  artifacts: z.array(
    z.object({
      logical_name: z.string().min(1),
      path: z.string().min(1),
      size_bytes: z.number().int().nonnegative(),
      sha256: z.string().min(1),
      upload_url: z.string().min(1),
      upload_token: z.string().min(1),
    }),
  ),
});

export const CleanupCompletePayloadSchema = z.object({
  attempt_id: z.string().min(1),
  lease_id: z.string().min(1),
  lease_epoch: z.number().int().positive(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  message: z.string().optional(),
});

export type LeaseOfferPayload = z.infer<typeof LeaseOfferPayloadSchema>;
export type LeaseAcceptPayload = z.infer<typeof LeaseAcceptPayloadSchema>;
export type LeaseRejectPayload = z.infer<typeof LeaseRejectPayloadSchema>;
export type PrepareSourcePayload = z.infer<typeof PrepareSourcePayloadSchema>;
export type PrepareSourceFullPayload = z.infer<typeof PrepareSourceFullPayloadSchema>;
export type PrepareSourceGitOverlayPayload = z.infer<typeof PrepareSourceGitOverlayPayloadSchema>;
export type SourceNeedPayload = z.infer<typeof SourceNeedPayloadSchema>;
export type BundleDownloadPayload = z.infer<typeof BundleDownloadPayloadSchema>;
export type SourceReadyPayload = z.infer<typeof SourceReadyPayloadSchema>;
export type RunJobPayload = z.infer<typeof RunJobPayloadSchema>;
export type CancelJobPayload = z.infer<typeof CancelJobPayloadSchema>;
export type JobStartedPayload = z.infer<typeof JobStartedPayloadSchema>;
export type LogChunkPayload = z.infer<typeof LogChunkPayloadSchema>;
export type JobExitPayload = z.infer<typeof JobExitPayloadSchema>;
export type ArtifactManifestPayload = z.infer<typeof ArtifactManifestPayloadSchema>;
export type ArtifactUploadGrantPayload = z.infer<typeof ArtifactUploadGrantPayloadSchema>;
export type CleanupCompletePayload = z.infer<typeof CleanupCompletePayloadSchema>;

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
