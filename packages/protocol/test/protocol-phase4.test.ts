import { describe, expect, it } from 'vitest';
import {
  ArtifactManifestPayloadSchema,
  ArtifactUploadGrantPayloadSchema,
  JobExitPayloadSchema,
  LeaseOfferPayloadSchema,
  LogChunkPayloadSchema,
  PrepareSourcePayloadSchema,
  WireMessageEnvelopeSchema,
} from '../src/messages.js';

describe('Phase 4 Protocol Schemas', () => {
  it('validates LeaseOffer payload', () => {
    const valid = LeaseOfferPayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      job_id: 'job_123',
      job_request: {
        client_request_id: 'req_123',
        source: { project_root: 'C:/test', cwd: '.' },
        execution: { script: 'echo hi' },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_123',
        content_id: 'abc123hash',
        size_bytes: 1024,
        sha256: 'hash123',
      },
      lease_ttl_seconds: 300,
    });
    expect(valid.success).toBe(true);

    const missingJobId = LeaseOfferPayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      job_request: {
        client_request_id: 'req_123',
        source: { project_root: 'C:/test', cwd: '.' },
        execution: { script: 'echo hi' },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_123',
        content_id: 'abc123hash',
        size_bytes: 1024,
        sha256: 'hash123',
      },
      lease_ttl_seconds: 300,
    });
    expect(missingJobId.success).toBe(false);
  });

  it('validates PrepareSource payload', () => {
    const valid = PrepareSourcePayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      download_url: 'https://127.0.0.1:7411/data/v1/attempts/att_123/snapshot',
      data_token: 'jwt_token_string',
      expected_size_bytes: 1024,
      expected_sha256: 'hash123',
    });
    expect(valid.success).toBe(true);
  });

  it('validates LogChunk payload', () => {
    const valid = LogChunkPayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'aGVsbG8=',
    });
    expect(valid.success).toBe(true);
  });

  it('validates JobExit payload', () => {
    const valid = JobExitPayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      exit_code: 0,
      outcome: 'succeeded',
    });
    expect(valid.success).toBe(true);
  });

  it('separates artifact_manifest (Agent→Controller) from artifact_upload_grant', () => {
    const manifest = ArtifactManifestPayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      artifacts: [
        {
          logical_name: 'out.bin',
          path: '/tmp/out.bin',
          size_bytes: 10,
          sha256: 'abc',
        },
      ],
    });
    expect(manifest.success).toBe(true);

    const grant = ArtifactUploadGrantPayloadSchema.safeParse({
      attempt_id: 'att_123',
      lease_id: 'lease_123',
      lease_epoch: 1,
      artifacts: [
        {
          logical_name: 'out.bin',
          path: '/tmp/out.bin',
          size_bytes: 10,
          sha256: 'abc',
          upload_url: 'https://controller:7411/data/v1/attempts/att_123/artifacts/out.bin',
          upload_token: 'tok',
        },
      ],
    });
    expect(grant.success).toBe(true);

    const grantEnvelope = WireMessageEnvelopeSchema.safeParse({
      protocol: 1,
      type: 'artifact_upload_grant',
      message_id: 'msg_1',
      sent_at: new Date().toISOString(),
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      payload: {},
    });
    expect(grantEnvelope.success).toBe(true);
  });

  it('enforces attempt_id, lease_id, lease_epoch on job-scoped wire envelope', () => {
    const invalidEnvelope = WireMessageEnvelopeSchema.safeParse({
      protocol: 1,
      type: 'run_job',
      message_id: 'msg_1',
      sent_at: new Date().toISOString(),
      attempt_id: null,
      lease_id: null,
      lease_epoch: null,
      payload: { attempt_id: 'att_1', lease_id: 'lease_1', lease_epoch: 1 },
    });
    expect(invalidEnvelope.success).toBe(false);

    const validEnvelope = WireMessageEnvelopeSchema.safeParse({
      protocol: 1,
      type: 'run_job',
      message_id: 'msg_1',
      sent_at: new Date().toISOString(),
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      payload: { attempt_id: 'att_1', lease_id: 'lease_1', lease_epoch: 1 },
    });
    expect(validEnvelope.success).toBe(true);
  });
});
