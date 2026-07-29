import { RboError } from '@rbo/shared';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';

// Idempotency persistence for job_submit (§11.2.1, §25.2 job_submissions):
// the (client_id, client_request_id) pair is reserved before any snapshot
// work starts, so a retried network request can always learn the outcome.

export type SubmissionState = 'capturing' | 'captured' | 'failed';

export interface SubmissionRow {
  client_id: string;
  client_request_id: string;
  state: SubmissionState;
  job_id: string | null;
  response_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReserveResult {
  created: boolean;
  submission: SubmissionRow;
}

export function getSubmission(
  db: ControllerDatabase,
  clientId: string,
  clientRequestId: string,
): SubmissionRow | null {
  const row = db
    .prepare('SELECT * FROM job_submissions WHERE client_id = ? AND client_request_id = ?')
    .get(clientId, clientRequestId);
  return (row as SubmissionRow | undefined) ?? null;
}

export function reserveSubmission(
  db: ControllerDatabase,
  clientId: string,
  clientRequestId: string,
): ReserveResult {
  const timestamp = nowIso();
  const insert = db.prepare(
    `INSERT INTO job_submissions (client_id, client_request_id, state, created_at, updated_at)
     VALUES (?, ?, 'capturing', ?, ?)
     ON CONFLICT (client_id, client_request_id) DO NOTHING`,
  );
  const info = insert.run(clientId, clientRequestId, timestamp, timestamp);
  const submission = getSubmission(db, clientId, clientRequestId);
  if (!submission) {
    throw RboError.internal('Failed to reserve job submission');
  }
  return { created: info.changes === 1, submission };
}

export function completeSubmission(
  db: ControllerDatabase,
  clientId: string,
  clientRequestId: string,
  state: Exclude<SubmissionState, 'capturing'>,
  payload: Record<string, unknown>,
  jobId?: string,
): SubmissionRow {
  const existing = getSubmission(db, clientId, clientRequestId);
  if (!existing) {
    throw RboError.validation('Unknown job submission', {
      client_id: clientId,
      client_request_id: clientRequestId,
    });
  }
  // §25.2: captured and failed are immutable for this idempotency key.
  if (existing.state !== 'capturing') {
    throw RboError.validation(
      `Submission is already terminal (${existing.state}) and cannot transition to ${state}`,
      { client_id: clientId, client_request_id: clientRequestId },
    );
  }

  const column = state === 'captured' ? 'response_json' : 'error_json';
  db.prepare(
    `UPDATE job_submissions
     SET state = ?, ${column} = ?, job_id = COALESCE(?, job_id), updated_at = ?
     WHERE client_id = ? AND client_request_id = ?`,
  ).run(state, JSON.stringify(payload), jobId ?? null, nowIso(), clientId, clientRequestId);

  const updated = getSubmission(db, clientId, clientRequestId);
  if (!updated) {
    throw RboError.internal('Submission disappeared during update');
  }
  return updated;
}
