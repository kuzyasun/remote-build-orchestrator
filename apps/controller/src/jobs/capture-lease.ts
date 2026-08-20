import { randomBytes } from 'node:crypto';
import type { ControllerDatabase } from '../storage/database.js';
import { type SubmissionRow, getSubmission, reserveSubmission } from './submissions.js';

const DEFAULT_CAPTURE_LEASE_TTL_MS = 30_000;

export interface CaptureLeaseKey {
  clientId: string;
  clientRequestId: string;
}

export interface CaptureLeaseIdentity extends CaptureLeaseKey {
  ownerToken: string;
  fencingGeneration: number;
}

export interface CaptureLease extends CaptureLeaseIdentity {
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureLeaseOptions {
  ttlMs?: number;
  now?: () => Date;
  ownerToken?: string;
}

export interface CaptureLeaseResult {
  acquired: boolean;
  reason?: 'active' | 'terminal' | 'missing';
  reclaimed: boolean;
  lease: CaptureLease | null;
  submission: SubmissionRow | null;
}

function clock(options: CaptureLeaseOptions): Date {
  const current = options.now?.() ?? new Date();
  if (Number.isNaN(current.getTime())) throw new Error('Invalid capture lease clock');
  return current;
}

function ttl(options: CaptureLeaseOptions): number {
  const value = options.ttlMs ?? DEFAULT_CAPTURE_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Capture lease TTL must be a positive safe integer');
  }
  return value;
}

function newOwnerToken(options: CaptureLeaseOptions): string {
  return options.ownerToken ?? randomBytes(24).toString('base64url');
}

function toLease(row: unknown): CaptureLease {
  const value = row as {
    client_id: string;
    client_request_id: string;
    owner_token: string;
    fencing_generation: number;
    lease_expires_at: string;
    created_at: string;
    updated_at: string;
  };
  return {
    clientId: value.client_id,
    clientRequestId: value.client_request_id,
    ownerToken: value.owner_token,
    fencingGeneration: value.fencing_generation,
    expiresAt: value.lease_expires_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

export function getCaptureLease(
  db: ControllerDatabase,
  { clientId, clientRequestId }: CaptureLeaseKey,
): CaptureLease | null {
  const row = db
    .prepare(
      `SELECT client_id, client_request_id, owner_token, fencing_generation,
              lease_expires_at, created_at, updated_at
         FROM snapshot_capture_leases
        WHERE client_id = ? AND client_request_id = ?`,
    )
    .get(clientId, clientRequestId);
  return row ? toLease(row) : null;
}

function getSubmissionForLease(db: ControllerDatabase, key: CaptureLeaseKey): SubmissionRow | null {
  return getSubmission(db, key.clientId, key.clientRequestId);
}

/**
 * Reserve the idempotency key and acquire its capture owner lease. A terminal
 * reservation is returned as-is and never receives a lease.
 */
export function reserveCaptureLease(
  db: ControllerDatabase,
  key: CaptureLeaseKey,
  options: CaptureLeaseOptions = {},
): CaptureLeaseResult {
  const reservation = reserveSubmission(db, key.clientId, key.clientRequestId);
  const submission = reservation.submission;
  if (submission.state !== 'capturing') {
    return {
      acquired: false,
      reason: 'terminal',
      reclaimed: false,
      lease: getCaptureLease(db, key),
      submission,
    };
  }
  return acquireCaptureLease(db, key, options);
}

/** Acquire a new lease or reclaim only an expired capturing lease. */
export function acquireCaptureLease(
  db: ControllerDatabase,
  key: CaptureLeaseKey,
  options: CaptureLeaseOptions = {},
): CaptureLeaseResult {
  const submission = getSubmissionForLease(db, key);
  if (!submission) {
    return { acquired: false, reason: 'missing', reclaimed: false, lease: null, submission: null };
  }
  if (submission.state !== 'capturing') {
    return {
      acquired: false,
      reason: 'terminal',
      reclaimed: false,
      lease: getCaptureLease(db, key),
      submission,
    };
  }

  const current = clock(options);
  const currentIso = current.toISOString();
  const expiresAt = new Date(current.getTime() + ttl(options)).toISOString();
  const ownerToken = newOwnerToken(options);
  const insert = db
    .prepare(
      `INSERT INTO snapshot_capture_leases
         (client_id, client_request_id, owner_token, fencing_generation,
          lease_expires_at, created_at, updated_at)
       SELECT ?, ?, ?, 1, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM job_submissions
            WHERE client_id = ? AND client_request_id = ? AND state = 'capturing'
         )
       ON CONFLICT (client_id, client_request_id) DO NOTHING`,
    )
    .run(
      key.clientId,
      key.clientRequestId,
      ownerToken,
      expiresAt,
      currentIso,
      currentIso,
      key.clientId,
      key.clientRequestId,
    );
  if (insert.changes === 1) {
    return {
      acquired: true,
      reclaimed: false,
      lease: getCaptureLease(db, key),
      submission,
    };
  }

  const previous = getCaptureLease(db, key);
  if (!previous) {
    return { acquired: false, reason: 'missing', reclaimed: false, lease: null, submission };
  }
  const reclaimed = reclaimExpiredCaptureLease(db, key, previous, {
    ...options,
    ownerToken,
    now: () => current,
  });
  if (reclaimed) {
    return {
      acquired: true,
      reclaimed: true,
      lease: getCaptureLease(db, key),
      submission,
    };
  }
  return {
    acquired: false,
    reason: 'active',
    reclaimed: false,
    lease: getCaptureLease(db, key),
    submission,
  };
}

/** Renew only the still-current, unexpired owner. */
export function renewCaptureLease(
  db: ControllerDatabase,
  identity: CaptureLeaseIdentity,
  options: CaptureLeaseOptions = {},
): CaptureLease | null {
  const current = clock(options);
  const currentIso = current.toISOString();
  const expiresAt = new Date(current.getTime() + ttl(options)).toISOString();
  const info = db
    .prepare(
      `UPDATE snapshot_capture_leases
          SET lease_expires_at = ?, updated_at = ?
        WHERE client_id = ? AND client_request_id = ?
          AND owner_token = ? AND fencing_generation = ?
          AND lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM job_submissions
             WHERE client_id = ? AND client_request_id = ? AND state = 'capturing'
          )`,
    )
    .run(
      expiresAt,
      currentIso,
      identity.clientId,
      identity.clientRequestId,
      identity.ownerToken,
      identity.fencingGeneration,
      currentIso,
      identity.clientId,
      identity.clientRequestId,
    );
  return info.changes === 1 ? getCaptureLease(db, identity) : null;
}

/**
 * Reclaim with a compare-and-swap on the observed owner and generation. The
 * SQL predicate makes two reclaimers race safely: only one can advance the
 * fencing generation, and terminal submissions are never reclaimable.
 */
export function reclaimExpiredCaptureLease(
  db: ControllerDatabase,
  key: CaptureLeaseKey,
  expected: Pick<CaptureLeaseIdentity, 'ownerToken' | 'fencingGeneration'>,
  options: CaptureLeaseOptions = {},
): boolean {
  const current = clock(options);
  const currentIso = current.toISOString();
  const expiresAt = new Date(current.getTime() + ttl(options)).toISOString();
  const ownerToken = newOwnerToken(options);
  const info = db
    .prepare(
      `UPDATE snapshot_capture_leases
          SET owner_token = ?, fencing_generation = fencing_generation + 1,
              lease_expires_at = ?, updated_at = ?
        WHERE client_id = ? AND client_request_id = ?
          AND owner_token = ? AND fencing_generation = ?
          AND lease_expires_at <= ?
          AND EXISTS (
            SELECT 1 FROM job_submissions
             WHERE client_id = ? AND client_request_id = ? AND state = 'capturing'
          )`,
    )
    .run(
      ownerToken,
      expiresAt,
      currentIso,
      key.clientId,
      key.clientRequestId,
      expected.ownerToken,
      expected.fencingGeneration,
      currentIso,
      key.clientId,
      key.clientRequestId,
    );
  return info.changes === 1;
}

/** Release only the exact owner generation; stale owners cannot clean others. */
export function releaseCaptureLease(
  db: ControllerDatabase,
  identity: CaptureLeaseIdentity,
): boolean {
  const info = db
    .prepare(
      `DELETE FROM snapshot_capture_leases
        WHERE client_id = ? AND client_request_id = ?
          AND owner_token = ? AND fencing_generation = ?`,
    )
    .run(
      identity.clientId,
      identity.clientRequestId,
      identity.ownerToken,
      identity.fencingGeneration,
    );
  return info.changes === 1;
}

/** Conditional authority check for the later publication transaction. */
export function hasCaptureLeaseAuthority(
  db: ControllerDatabase,
  identity: CaptureLeaseIdentity,
  now: Date = new Date(),
): boolean {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid capture lease clock');
  const row = db
    .prepare(
      `SELECT 1
         FROM snapshot_capture_leases AS lease
         JOIN job_submissions AS submission
           ON submission.client_id = lease.client_id
          AND submission.client_request_id = lease.client_request_id
        WHERE lease.client_id = ? AND lease.client_request_id = ?
          AND lease.owner_token = ? AND lease.fencing_generation = ?
          AND lease.lease_expires_at > ? AND submission.state = 'capturing'`,
    )
    .get(
      identity.clientId,
      identity.clientRequestId,
      identity.ownerToken,
      identity.fencingGeneration,
      now.toISOString(),
    );
  return row !== undefined;
}
