import type { ControllerIdentity } from '@rbo/shared';
import { signEdDsaJwt, verifyEdDsaJwt } from '@rbo/shared';

export interface DataTokenClaims {
  agent_id: string;
  job_id: string;
  attempt_id: string;
  lease_id: string;
  lease_epoch: number;
  op: 'snapshot_download' | 'artifact_upload';
  artifact_id?: string;
  ttl_seconds?: number;
}

export interface VerifiedDataToken {
  agentId: string;
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  op: 'snapshot_download' | 'artifact_upload';
  artifactId?: string;
}

const DEFAULT_DATA_TOKEN_TTL = 900; // 15 minutes

export function issueDataToken(identity: ControllerIdentity, claims: DataTokenClaims): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = claims.ttl_seconds ?? DEFAULT_DATA_TOKEN_TTL;

  return signEdDsaJwt(identity.signingPrivateKeyPem, {
    sub: claims.agent_id,
    aud: identity.controllerId,
    iat: now,
    exp: now + ttl,
    job_id: claims.job_id,
    attempt_id: claims.attempt_id,
    lease_id: claims.lease_id,
    lease_epoch: claims.lease_epoch,
    op: claims.op,
    ...(claims.artifact_id ? { artifact_id: claims.artifact_id } : {}),
  });
}

export function verifyDataToken(
  identity: ControllerIdentity,
  token: string,
): VerifiedDataToken | null {
  const claims = verifyEdDsaJwt(identity.signingPublicKeyPem, token);
  if (!claims || claims.aud !== identity.controllerId) {
    return null;
  }

  const agentId = typeof claims.sub === 'string' ? claims.sub : '';
  const jobId = typeof claims.job_id === 'string' ? claims.job_id : '';
  const attemptId = typeof claims.attempt_id === 'string' ? claims.attempt_id : '';
  const leaseId = typeof claims.lease_id === 'string' ? claims.lease_id : '';
  const leaseEpoch =
    typeof claims.lease_epoch === 'number' ? claims.lease_epoch : Number(claims.lease_epoch);
  const op =
    claims.op === 'snapshot_download' || claims.op === 'artifact_upload' ? claims.op : null;

  if (!agentId || !jobId || !attemptId || !leaseId || !leaseEpoch || !op) {
    return null;
  }

  return {
    agentId,
    jobId,
    attemptId,
    leaseId,
    leaseEpoch,
    op,
    ...(claims.artifact_id ? { artifactId: String(claims.artifact_id) } : {}),
  };
}
