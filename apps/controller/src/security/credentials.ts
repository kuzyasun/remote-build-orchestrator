import { RboError, publicKeyThumbprint, signEdDsaJwt, verifyEdDsaJwt } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';

const CREDENTIAL_TTL_SECONDS = 30 * 24 * 3600;

interface AgentSecurityRow {
  id: string;
  device_public_key: string | null;
  device_thumbprint: string | null;
  credential_version: number;
  revoked_at: string | null;
}

function getAgentSecurityRow(db: ControllerDatabase, agentId: string): AgentSecurityRow | null {
  const row = db
    .prepare(
      'SELECT id, device_public_key, device_thumbprint, credential_version, revoked_at FROM agents WHERE id = ?',
    )
    .get(agentId);
  return (row as AgentSecurityRow | undefined) ?? null;
}

// Issuing always rotates: credential_version is bumped and older credentials
// stop verifying, which gives both rotation and re-issue-after-compromise.
export function issueAgentCredential(
  db: ControllerDatabase,
  identity: ControllerIdentity,
  agentId: string,
): string {
  const agent = getAgentSecurityRow(db, agentId);
  if (!agent) {
    throw RboError.validation(`Unknown agent '${agentId}'`);
  }
  if (agent.revoked_at) {
    throw RboError.validation(`Agent '${agentId}' is revoked`);
  }
  if (!agent.device_thumbprint) {
    throw RboError.internal(`Agent '${agentId}' has no device key on record`);
  }

  const nextVersion = agent.credential_version + 1;
  db.prepare('UPDATE agents SET credential_version = ? WHERE id = ?').run(nextVersion, agentId);

  return signEdDsaJwt(identity.signingPrivateKeyPem, {
    sub: agentId,
    aud: identity.controllerId,
    device_thumbprint: agent.device_thumbprint,
    credential_version: nextVersion,
    exp: Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS,
  });
}

export interface VerifiedCredential {
  agentId: string;
  devicePublicKeyPem: string;
  credentialVersion: number;
}

export function verifyAgentCredential(
  db: ControllerDatabase,
  identity: ControllerIdentity,
  credential: string,
): VerifiedCredential | null {
  const claims = verifyEdDsaJwt(identity.signingPublicKeyPem, credential);
  if (!claims || claims.aud !== identity.controllerId || typeof claims.sub !== 'string') {
    return null;
  }
  const agent = getAgentSecurityRow(db, claims.sub);
  if (!agent || agent.revoked_at || !agent.device_public_key || !agent.device_thumbprint) {
    return null;
  }
  if (claims.credential_version !== agent.credential_version) {
    return null;
  }
  if (claims.device_thumbprint !== agent.device_thumbprint) {
    return null;
  }
  // Defense in depth: the stored key must still hash to the stored thumbprint.
  if (publicKeyThumbprint(agent.device_public_key) !== agent.device_thumbprint) {
    return null;
  }
  return {
    agentId: agent.id,
    devicePublicKeyPem: agent.device_public_key,
    credentialVersion: agent.credential_version,
  };
}

export function markAgentSeen(db: ControllerDatabase, agentId: string, state: string): void {
  db.prepare('UPDATE agents SET state = ?, last_seen_at = ? WHERE id = ?').run(
    state,
    nowIso(),
    agentId,
  );
}
