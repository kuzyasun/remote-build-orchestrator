import { afterEach, describe, expect, it } from 'vitest';
import {
  type CaptureLease,
  acquireCaptureLease,
  getCaptureLease,
  hasCaptureLeaseAuthority,
  reclaimExpiredCaptureLease,
  releaseCaptureLease,
  renewCaptureLease,
  reserveCaptureLease,
} from '../src/jobs/capture-lease.js';
import { completeSubmission } from '../src/jobs/submissions.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

function newDb() {
  const db = openDatabase(':memory:');
  migrateToLatest(db);
  return db;
}

function clockAt(value: string) {
  const date = new Date(value);
  return () => date;
}

const key = { clientId: 'client-a', clientRequestId: 'request-a' };

function requireLease(lease: CaptureLease | null): CaptureLease {
  if (!lease) throw new Error('Expected capture lease');
  return lease;
}

describe('capture-owner leases (§5.6)', () => {
  const databases: ReturnType<typeof newDb>[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('persists an owner token, generation, and deterministic expiry on reservation', () => {
    const db = newDb();
    databases.push(db);
    const result = reserveCaptureLease(db, key, {
      ownerToken: 'owner-1',
      ttlMs: 10_000,
      now: clockAt('2026-08-21T10:00:00.000Z'),
    });

    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(false);
    expect(result.lease).toMatchObject({
      ownerToken: 'owner-1',
      fencingGeneration: 1,
      expiresAt: '2026-08-21T10:00:10.000Z',
    });
    expect(getCaptureLease(db, key)).toEqual(result.lease);
  });

  it('keeps an active owner exclusive while allowing that owner to renew', () => {
    const db = newDb();
    databases.push(db);
    const first = reserveCaptureLease(db, key, {
      ownerToken: 'owner-1',
      ttlMs: 10_000,
      now: clockAt('2026-08-21T10:00:00.000Z'),
    });
    const second = acquireCaptureLease(db, key, {
      ownerToken: 'owner-2',
      now: clockAt('2026-08-21T10:00:01.000Z'),
    });

    expect(second).toMatchObject({ acquired: false, reason: 'active', reclaimed: false });
    expect(
      renewCaptureLease(db, requireLease(first.lease), {
        ttlMs: 10_000,
        now: clockAt('2026-08-21T10:00:02.000Z'),
      }),
    ).toMatchObject({
      ownerToken: 'owner-1',
      fencingGeneration: 1,
      expiresAt: '2026-08-21T10:00:12.000Z',
    });
  });

  it('reclaims an expired lease with one CAS generation advance', () => {
    const db = newDb();
    databases.push(db);
    const first = reserveCaptureLease(db, key, {
      ownerToken: 'owner-1',
      ttlMs: 10_000,
      now: clockAt('2026-08-21T10:00:00.000Z'),
    });
    const observed = requireLease(getCaptureLease(db, key));
    const reclaimed = reclaimExpiredCaptureLease(db, key, observed, {
      ownerToken: 'owner-2',
      ttlMs: 10_000,
      now: clockAt('2026-08-21T10:00:10.000Z'),
    });
    const raced = reclaimExpiredCaptureLease(db, key, observed, {
      ownerToken: 'owner-3',
      now: clockAt('2026-08-21T10:00:10.000Z'),
    });

    expect(reclaimed).toBe(true);
    expect(raced).toBe(false);
    expect(getCaptureLease(db, key)).toMatchObject({ ownerToken: 'owner-2', fencingGeneration: 2 });
    expect(releaseCaptureLease(db, requireLease(first.lease))).toBe(false);
  });

  it('rejects stale renewal and authority after another owner reclaims', () => {
    const db = newDb();
    databases.push(db);
    const first = reserveCaptureLease(db, key, {
      ownerToken: 'owner-1',
      ttlMs: 1_000,
      now: clockAt('2026-08-21T10:00:00.000Z'),
    });
    const second = acquireCaptureLease(db, key, {
      ownerToken: 'owner-2',
      ttlMs: 1_000,
      now: clockAt('2026-08-21T10:00:01.000Z'),
    });

    expect(second).toMatchObject({ acquired: true, reclaimed: true });
    expect(
      renewCaptureLease(db, requireLease(first.lease), {
        now: clockAt('2026-08-21T10:00:01.500Z'),
      }),
    ).toBeNull();
    expect(
      hasCaptureLeaseAuthority(db, requireLease(first.lease), new Date('2026-08-21T10:00:01.500Z')),
    ).toBe(false);
    expect(
      hasCaptureLeaseAuthority(
        db,
        requireLease(second.lease),
        new Date('2026-08-21T10:00:01.500Z'),
      ),
    ).toBe(true);
  });

  it('does not create or reclaim a lease for captured or failed submissions', () => {
    const db = newDb();
    databases.push(db);
    const captured = reserveCaptureLease(
      db,
      { clientId: 'client-a', clientRequestId: 'captured' },
      {
        ownerToken: 'owner-c',
        now: clockAt('2026-08-21T10:00:00.000Z'),
      },
    );
    completeSubmission(db, 'client-a', 'captured', 'captured', { job_id: 'job-1' });
    const failed = reserveCaptureLease(
      db,
      { clientId: 'client-a', clientRequestId: 'failed' },
      {
        ownerToken: 'owner-f',
        now: clockAt('2026-08-21T10:00:00.000Z'),
      },
    );
    completeSubmission(db, 'client-a', 'failed', 'failed', { error: 'x' });

    expect(captured.lease).not.toBeNull();
    expect(failed.lease).not.toBeNull();
    expect(
      reserveCaptureLease(
        db,
        { clientId: 'client-a', clientRequestId: 'captured' },
        { ownerToken: 'owner-new' },
      ),
    ).toMatchObject({ acquired: false, reason: 'terminal' });
    expect(
      reserveCaptureLease(
        db,
        { clientId: 'client-a', clientRequestId: 'failed' },
        { ownerToken: 'owner-new' },
      ),
    ).toMatchObject({ acquired: false, reason: 'terminal' });
    expect(
      acquireCaptureLease(
        db,
        { clientId: 'client-a', clientRequestId: 'captured' },
        { ownerToken: 'owner-new' },
      ),
    ).toMatchObject({ acquired: false, reason: 'terminal' });
    expect(
      reclaimExpiredCaptureLease(
        db,
        { clientId: 'client-a', clientRequestId: 'captured' },
        requireLease(captured.lease),
        {
          ownerToken: 'owner-new',
          now: clockAt('2026-08-21T10:00:30.000Z'),
        },
      ),
    ).toBe(false);
  });
});
