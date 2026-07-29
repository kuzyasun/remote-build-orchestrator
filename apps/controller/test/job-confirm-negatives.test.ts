import { createHash } from 'node:crypto';
import type { JobRequest } from '@rbo/protocol';
import type { ControllerIdentity } from '@rbo/shared';
import { generateDeviceKeyPair, signEdDsaJwt } from '@rbo/shared';
import { stableStringify } from '@rbo/snapshot';
import { describe, expect, it } from 'vitest';
import { createJob, getJob, persistSnapshot, transitionJobState } from '../src/jobs/lifecycle.js';
import {
  type SubmitJobContext,
  handleJobConfirm,
  verifyConfirmationToken,
} from '../src/jobs/submit.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';

const CONFIRMATION_TTL_SECONDS = 300;

function requestHash(request: JobRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

interface ConfirmationFixture {
  db: ControllerDatabase;
  identity: ControllerIdentity;
  jobId: string;
  request: JobRequest;
  requestHashValue: string;
  contentId: string;
  ctx: SubmitJobContext;
  issueToken: (overrides?: {
    sub?: string;
    aud?: string;
    exp?: number;
    request_hash?: string;
    content_id?: string;
    risk_level?: string;
    signingKey?: string;
  }) => string;
}

function makeConfirmationFixture(): ConfirmationFixture {
  const db = openDatabase(':memory:');
  migrateToLatest(db);
  const keys = generateDeviceKeyPair();
  const identity: ControllerIdentity = {
    controllerId: 'controller_test_confirm',
    tlsCertPem: '',
    tlsKeyPem: '',
    signingPublicKeyPem: keys.publicKeyPem,
    signingPrivateKeyPem: keys.privateKeyPem,
    fingerprint: 'sha256:test',
  };

  const request: JobRequest = {
    client_request_id: 'req_confirm_neg',
    name: 'confirm-negative-test',
    source: { project_root: '/tmp', cwd: '.' },
    execution: { script: 'echo hi', cancel_grace_seconds: 5 },
    risk_level: 'destructive',
  };
  const job = createJob(db, {
    clientId: 'client-confirm',
    clientRequestId: request.client_request_id,
    request,
    initialState: 'created',
  });

  const snapshotId = 'snap_confirm_neg';
  const contentId = 'content_confirm_abc';
  persistSnapshot(db, {
    snapshotId,
    contentId,
    repoId: 'local',
    baseCommit: null,
    dirty: false,
    manifestPath: '/tmp/manifest.json',
    payloadPath: '/tmp/payload.bin',
    sizeBytes: 64,
    sha256: 'a'.repeat(64),
  });
  transitionJobState(db, job.id, 'awaiting_confirmation', { snapshot_id: snapshotId });

  const requestHashValue = requestHash(request);
  const ctx: SubmitJobContext = {
    clientId: 'client-confirm',
    controllerIdentity: identity,
    db,
    dataDir: '/tmp/rbo-confirm-neg',
    allowedProjectRoots: ['/tmp'],
    allowedArtifactDestinations: [],
  };

  const issueToken = (overrides?: {
    sub?: string;
    aud?: string;
    exp?: number;
    request_hash?: string;
    content_id?: string;
    risk_level?: string;
    signingKey?: string;
  }): string => {
    const jobId = overrides?.sub ?? job.id;
    return signEdDsaJwt(overrides?.signingKey ?? identity.signingPrivateKeyPem, {
      sub: jobId,
      aud: overrides?.aud ?? identity.controllerId,
      exp: overrides?.exp ?? Math.floor(Date.now() / 1000) + CONFIRMATION_TTL_SECONDS,
      job_id: jobId,
      request_hash: overrides?.request_hash ?? requestHashValue,
      content_id: overrides?.content_id ?? contentId,
      risk_level: overrides?.risk_level ?? request.risk_level,
    });
  };

  return {
    db,
    identity,
    jobId: job.id,
    request,
    requestHashValue,
    contentId,
    ctx,
    issueToken,
  };
}

describe('verifyConfirmationToken negative paths (§1.1)', () => {
  it('rejects a token signed with the wrong key', () => {
    const { identity, issueToken } = makeConfirmationFixture();
    const attacker = generateDeviceKeyPair();
    const token = issueToken({ signingKey: attacker.privateKeyPem });
    expect(verifyConfirmationToken(identity, token)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { identity, issueToken } = makeConfirmationFixture();
    const token = issueToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect(verifyConfirmationToken(identity, token)).toBeNull();
  });

  it('rejects a token with the wrong aud', () => {
    const { identity, issueToken } = makeConfirmationFixture();
    const token = issueToken({ aud: 'controller_other' });
    expect(verifyConfirmationToken(identity, token)).toBeNull();
  });

  it('accepts a valid token with matching claims', () => {
    const { identity, jobId, requestHashValue, contentId, request, issueToken } =
      makeConfirmationFixture();
    const claims = verifyConfirmationToken(identity, issueToken());
    expect(claims).toEqual({
      job_id: jobId,
      request_hash: requestHashValue,
      content_id: contentId,
      risk_level: request.risk_level,
    });
  });
});

describe('handleJobConfirm negative paths (§1.1)', () => {
  it('rejects a forged / wrong-key confirmation token', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const attacker = generateDeviceKeyPair();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ signingKey: attacker.privateKeyPem }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Invalid or expired confirmation token',
      retryable: false,
    });
    expect(getJob(ctx.db, jobId)?.state).toBe('awaiting_confirmation');
  });

  it('rejects an expired confirmation token', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ exp: Math.floor(Date.now() / 1000) - 1 }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Invalid or expired confirmation token',
    });
  });

  it('rejects a token with the wrong aud', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ aud: 'controller_wrong' }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Invalid or expired confirmation token',
    });
  });

  it('rejects a token whose sub/job_id does not match the job', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ sub: 'job_other' }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Invalid or expired confirmation token',
    });
  });

  it('rejects a token with mismatched content_id', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ content_id: 'content_tampered' }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Confirmation token binding mismatch',
    });
    expect(getJob(ctx.db, jobId)?.state).toBe('awaiting_confirmation');
  });

  it('rejects a token with mismatched request_hash', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ request_hash: 'f'.repeat(64) }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Confirmation token binding mismatch',
    });
  });

  it('rejects a token with mismatched risk_level', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken({ risk_level: 'safe' }),
    });
    expect(result.error).toMatchObject({
      category: 'validation',
      message: 'Confirmation token binding mismatch',
    });
  });

  it('accepts a valid token and returns queued', async () => {
    const { ctx, jobId, issueToken } = makeConfirmationFixture();
    const result = await handleJobConfirm(ctx, {
      job_id: jobId,
      confirmation_token: issueToken(),
    });
    expect(result).toEqual({ job_id: jobId, state: 'queued' });
  });
});
