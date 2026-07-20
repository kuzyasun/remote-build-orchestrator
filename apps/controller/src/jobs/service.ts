import type { ControllerDatabase } from '../storage/database.js';

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
