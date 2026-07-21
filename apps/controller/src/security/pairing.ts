import { randomInt } from 'node:crypto';
import { RboError, generateId, publicKeyThumbprint } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { ulid } from 'ulid';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import { issueAgentCredential } from './credentials.js';

const PAIRING_TTL_MS = 15 * 60 * 1000;

export interface PairingRequestRow {
  id: string;
  device_public_key: string;
  device_thumbprint: string;
  display_name: string;
  hostname: string | null;
  metadata_json: string | null;
  one_time_code: string;
  state: 'pending' | 'approved' | 'claimed' | 'rejected' | 'expired';
  agent_id: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

export interface CreatePairingInput {
  devicePublicKeyPem: string;
  displayName: string;
  hostname: string | null;
  metadata?: Record<string, unknown>;
}

export function getPairingRequest(db: ControllerDatabase, id: string): PairingRequestRow | null {
  const row = db.prepare('SELECT * FROM pairing_requests WHERE id = ?').get(id);
  return (row as PairingRequestRow | undefined) ?? null;
}

/** Flip pending/approved rows past `expires_at` to `expired` (lazy GC on list/create). */
export function expireStalePairingRequests(db: ControllerDatabase): number {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE pairing_requests
       SET state = 'expired', resolved_at = COALESCE(resolved_at, ?)
       WHERE state IN ('pending', 'approved') AND expires_at <= ?`,
    )
    .run(now, now);
  return result.changes;
}

export function listPairingRequests(
  db: ControllerDatabase,
  state?: PairingRequestRow['state'],
): PairingRequestRow[] {
  expireStalePairingRequests(db);
  const rows = state
    ? db.prepare('SELECT * FROM pairing_requests WHERE state = ? ORDER BY created_at').all(state)
    : db.prepare('SELECT * FROM pairing_requests ORDER BY created_at').all();
  return rows as PairingRequestRow[];
}

export function createPairingRequest(
  db: ControllerDatabase,
  input: CreatePairingInput,
): PairingRequestRow {
  expireStalePairingRequests(db);
  const thumbprint = publicKeyThumbprint(input.devicePublicKeyPem);

  // One live request per device key: reuse an existing pending/approved one so
  // an agent retry loop does not spam the operator with duplicates.
  const existing = db
    .prepare(
      "SELECT * FROM pairing_requests WHERE device_thumbprint = ? AND state IN ('pending', 'approved') AND expires_at > ?",
    )
    .get(thumbprint, nowIso()) as PairingRequestRow | undefined;
  if (existing) {
    return existing;
  }

  const row: PairingRequestRow = {
    id: `pair_${ulid()}`,
    device_public_key: input.devicePublicKeyPem,
    device_thumbprint: thumbprint,
    display_name: input.displayName,
    hostname: input.hostname,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    one_time_code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    state: 'pending',
    agent_id: null,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    resolved_at: null,
  };
  db.prepare(
    `INSERT INTO pairing_requests
       (id, device_public_key, device_thumbprint, display_name, hostname, metadata_json,
        one_time_code, state, agent_id, created_at, expires_at, resolved_at)
     VALUES (@id, @device_public_key, @device_thumbprint, @display_name, @hostname, @metadata_json,
        @one_time_code, @state, @agent_id, @created_at, @expires_at, @resolved_at)`,
  ).run(row);
  return row;
}

export function approvePairingRequest(
  db: ControllerDatabase,
  identity: ControllerIdentity,
  requestId: string,
): { agentId: string } {
  const request = getPairingRequest(db, requestId);
  if (!request) {
    throw RboError.validation(`Unknown pairing request '${requestId}'`);
  }
  if (request.state !== 'pending') {
    throw RboError.validation(`Pairing request is ${request.state}, not pending`);
  }
  if (request.expires_at <= nowIso()) {
    db.prepare("UPDATE pairing_requests SET state = 'expired', resolved_at = ? WHERE id = ?").run(
      nowIso(),
      requestId,
    );
    throw RboError.validation('Pairing request has expired');
  }

  const agentId = generateId('agt');
  const approve = db.transaction(() => {
    db.prepare(
      `INSERT INTO agents
         (id, display_name, hostname, state, priority, max_jobs, capabilities_json, paired_at,
          device_public_key, device_thumbprint, credential_version)
       VALUES (?, ?, ?, 'offline', 0, 1, '{}', ?, ?, ?, 0)`,
    ).run(
      agentId,
      request.display_name,
      request.hostname,
      nowIso(),
      request.device_public_key,
      request.device_thumbprint,
    );
    db.prepare(
      "UPDATE pairing_requests SET state = 'approved', agent_id = ?, resolved_at = ? WHERE id = ?",
    ).run(agentId, nowIso(), requestId);
  });
  approve();
  void identity; // credential is issued at claim time
  return { agentId };
}

export function rejectPairingRequest(db: ControllerDatabase, requestId: string): void {
  const request = getPairingRequest(db, requestId);
  if (!request) {
    throw RboError.validation(`Unknown pairing request '${requestId}'`);
  }
  db.prepare("UPDATE pairing_requests SET state = 'rejected', resolved_at = ? WHERE id = ?").run(
    nowIso(),
    requestId,
  );
}

export interface ClaimResult {
  agentId: string;
  credential: string;
}

// Called when a device reconnects with pairing_request after approval:
// the credential is delivered exactly once over the verified TLS channel.
export function claimApprovedPairing(
  db: ControllerDatabase,
  identity: ControllerIdentity,
  devicePublicKeyPem: string,
): ClaimResult | null {
  const thumbprint = publicKeyThumbprint(devicePublicKeyPem);
  const request = db
    .prepare(
      "SELECT * FROM pairing_requests WHERE device_thumbprint = ? AND state = 'approved' AND agent_id IS NOT NULL",
    )
    .get(thumbprint) as PairingRequestRow | undefined;
  if (!request || !request.agent_id) {
    return null;
  }

  const credential = issueAgentCredential(db, identity, request.agent_id);
  db.prepare("UPDATE pairing_requests SET state = 'claimed', resolved_at = ? WHERE id = ?").run(
    nowIso(),
    request.id,
  );
  return { agentId: request.agent_id, credential };
}
