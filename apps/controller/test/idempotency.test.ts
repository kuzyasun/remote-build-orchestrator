import { describe, expect, it } from 'vitest';
import { completeSubmission, getSubmission, reserveSubmission } from '../src/jobs/submissions.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

function newDb() {
  const db = openDatabase(':memory:');
  migrateToLatest(db);
  return db;
}

describe('Idempotency namespace (client_id, client_request_id) (§25.2, Phase 1)', () => {
  it('reserves a new submission in capturing state', () => {
    const db = newDb();
    const result = reserveSubmission(db, 'client-a', 'req_1');
    expect(result.created).toBe(true);
    expect(result.submission.state).toBe('capturing');
  });

  it('returns the existing record for a repeated (client_id, client_request_id)', () => {
    const db = newDb();
    reserveSubmission(db, 'client-a', 'req_1');
    const repeat = reserveSubmission(db, 'client-a', 'req_1');
    expect(repeat.created).toBe(false);
    expect(repeat.submission.client_request_id).toBe('req_1');
  });

  it('does not conflict across different client_ids with the same client_request_id', () => {
    const db = newDb();
    const a = reserveSubmission(db, 'client-a', 'req_1');
    const b = reserveSubmission(db, 'client-b', 'req_1');
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(getSubmission(db, 'client-a', 'req_1')).not.toBeNull();
    expect(getSubmission(db, 'client-b', 'req_1')).not.toBeNull();
  });

  it('captured and failed states are immutable for the idempotency key', () => {
    const db = newDb();
    reserveSubmission(db, 'client-a', 'req_1');
    completeSubmission(db, 'client-a', 'req_1', 'captured', { job_id: 'job_1' });

    expect(() => completeSubmission(db, 'client-a', 'req_1', 'failed', { error: 'x' })).toThrow();

    const row = getSubmission(db, 'client-a', 'req_1');
    expect(row?.state).toBe('captured');
    expect(JSON.parse(row?.response_json ?? '{}').job_id).toBe('job_1');
  });
});
