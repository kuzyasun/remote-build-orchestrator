import type { JobEvent, JobRequest } from '@rbo/protocol';
import { JobEventSchema } from '@rbo/protocol';
import { generateId } from '@rbo/shared';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';

export interface JobRow {
  id: string;
  client_id: string;
  client_request_id: string;
  name: string | null;
  state: string;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  agent_id: string | null;
  snapshot_id: string | null;
  exit_code: number | null;
  failure_category: string | null;
  failure_message: string | null;
}

export interface AttemptRow {
  id: string;
  job_id: string;
  ordinal: number;
  agent_id: string | null;
  lease_id: string;
  lease_epoch: number;
  lease_deadline: string | null;
  state: string;
  outcome: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface SnapshotRow {
  id: string;
  content_id: string;
  repo_id: string;
  base_commit: string | null;
  dirty: number;
  manifest_path: string;
  payload_path: string | null;
  bundle_path: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_at: string;
  expires_at: string | null;
}

export function createJob(
  db: ControllerDatabase,
  input: {
    jobId?: string;
    clientId: string;
    clientRequestId: string;
    request: JobRequest;
    initialState: string;
    name?: string;
  },
): JobRow {
  const jobId = input.jobId ?? generateId('job');
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO jobs (
      id, client_id, client_request_id, name, state, created_at, updated_at, request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    input.clientId,
    input.clientRequestId,
    input.name ?? input.request.name ?? null,
    input.initialState,
    timestamp,
    timestamp,
    JSON.stringify(input.request),
  );
  const row = getJob(db, jobId);
  if (!row) {
    throw new Error('Failed to create job');
  }
  return row;
}

export function getJob(db: ControllerDatabase, jobId: string): JobRow | null {
  const row = db
    .prepare(
      `SELECT id, client_id, client_request_id, name, state, outcome, created_at, updated_at,
              queued_at, started_at, finished_at, agent_id, snapshot_id, exit_code,
              failure_category, failure_message
       FROM jobs WHERE id = ?`,
    )
    .get(jobId);
  return (row as JobRow | undefined) ?? null;
}

export function getJobRequest(db: ControllerDatabase, jobId: string): JobRequest | null {
  const row = db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(jobId) as
    | { request_json: string }
    | undefined;
  if (!row) {
    return null;
  }
  return JSON.parse(row.request_json) as JobRequest;
}

export function transitionJobState(
  db: ControllerDatabase,
  jobId: string,
  state: string,
  fields: Partial<{
    outcome: string | null;
    queued_at: string;
    started_at: string;
    finished_at: string;
    snapshot_id: string;
    exit_code: number | null;
    failure_category: string | null;
    failure_message: string | null;
    result_json: string;
  }> = {},
): JobRow {
  const sets = ['state = ?', 'updated_at = ?'];
  const values: unknown[] = [state, nowIso()];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  values.push(jobId);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  const row = getJob(db, jobId);
  if (!row) {
    throw new Error(`Job not found after transition: ${jobId}`);
  }
  return row;
}

export function createAttempt(db: ControllerDatabase, jobId: string, ordinal: number): AttemptRow {
  const attemptId = generateId('att');
  const leaseId = generateId('lease');
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO job_attempts (
      id, job_id, ordinal, lease_id, lease_epoch, state, started_at
    ) VALUES (?, ?, ?, ?, 1, 'starting', ?)`,
  ).run(attemptId, jobId, ordinal, leaseId, timestamp);
  const row = getAttempt(db, attemptId);
  if (!row) {
    throw new Error('Failed to create attempt');
  }
  return row;
}

export function getAttempt(db: ControllerDatabase, attemptId: string): AttemptRow | null {
  const row = db
    .prepare(
      `SELECT id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline,
              state, outcome, started_at, finished_at
       FROM job_attempts WHERE id = ?`,
    )
    .get(attemptId);
  return (row as AttemptRow | undefined) ?? null;
}

export function getLatestAttempt(db: ControllerDatabase, jobId: string): AttemptRow | null {
  const row = db
    .prepare(
      `SELECT id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline,
              state, outcome, started_at, finished_at
       FROM job_attempts WHERE job_id = ?
       ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(jobId);
  return (row as AttemptRow | undefined) ?? null;
}

export function transitionAttemptState(
  db: ControllerDatabase,
  attemptId: string,
  state: string,
  fields: Partial<{ outcome: string | null; finished_at: string }> = {},
): AttemptRow {
  const sets = ['state = ?'];
  const values: unknown[] = [state];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  values.push(attemptId);
  db.prepare(`UPDATE job_attempts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  const row = getAttempt(db, attemptId);
  if (!row) {
    throw new Error(`Attempt not found after transition: ${attemptId}`);
  }
  return row;
}

export function recordEvent(db: ControllerDatabase, event: JobEvent): JobEvent {
  const validated = JobEventSchema.parse(event);
  db.prepare(
    `INSERT INTO job_events (job_id, attempt_id, sequence, created_at, event_type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    validated.job_id,
    validated.attempt_id,
    validated.sequence,
    validated.created_at,
    validated.type,
    JSON.stringify(validated),
  );
  return validated;
}

export function nextEventSequence(db: ControllerDatabase, attemptId: string): number {
  const maxSeq = db
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM job_events WHERE attempt_id = ?')
    .get(attemptId) as { max_seq: number };
  return maxSeq.max_seq + 1;
}

export function createJobEvent(
  db: ControllerDatabase,
  partial: { type: JobEvent['type']; job_id: string; attempt_id: string } & Record<string, unknown>,
): JobEvent {
  return JobEventSchema.parse({
    ...partial,
    sequence: nextEventSequence(db, partial.attempt_id),
    created_at: nowIso(),
  });
}

export function persistSnapshot(
  db: ControllerDatabase,
  input: {
    snapshotId: string;
    contentId: string;
    repoId: string;
    baseCommit: string | null;
    dirty: boolean;
    manifestPath: string;
    payloadPath: string;
    sizeBytes: number;
    sha256: string;
  },
): SnapshotRow {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO snapshots (
      id, content_id, repo_id, base_commit, dirty, manifest_path, payload_path,
      size_bytes, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.snapshotId,
    input.contentId,
    input.repoId,
    input.baseCommit,
    input.dirty ? 1 : 0,
    input.manifestPath,
    input.payloadPath,
    input.sizeBytes,
    input.sha256,
    timestamp,
  );
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(input.snapshotId);
  return row as SnapshotRow;
}

export function getSnapshot(db: ControllerDatabase, snapshotId: string): SnapshotRow | null {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  return (row as SnapshotRow | undefined) ?? null;
}

export function isTerminalJobState(state: string): boolean {
  return state === 'completed';
}

export function isDestructiveRisk(riskLevel: string): boolean {
  return riskLevel === 'destructive' || riskLevel === 'hardware';
}
