export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

// Schema from §25.2. Each migration runs inside one transaction;
// PRAGMA user_version tracks the applied version.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  hostname TEXT,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  max_jobs INTEGER NOT NULL DEFAULT 1,
  capabilities_json TEXT NOT NULL,
  last_seen_at TEXT,
  paired_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE job_submissions (
  client_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('capturing', 'captured', 'failed')),
  job_id TEXT REFERENCES jobs(id),
  response_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, client_request_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  name TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  agent_id TEXT REFERENCES agents(id),
  snapshot_id TEXT REFERENCES snapshots(id),
  request_json TEXT NOT NULL,
  result_json TEXT,
  exit_code INTEGER,
  failure_category TEXT,
  failure_message TEXT,
  UNIQUE (client_id, client_request_id)
);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  lease_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  lease_deadline TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  toolchain_profiles_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (job_id, ordinal),
  UNIQUE (lease_id, lease_epoch)
);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (attempt_id, sequence)
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  base_commit TEXT,
  dirty INTEGER NOT NULL,
  manifest_path TEXT NOT NULL,
  payload_path TEXT,
  bundle_path TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  logical_name TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (attempt_id, logical_name)
);

CREATE INDEX idx_jobs_state_queued_at ON jobs(state, queued_at);
CREATE INDEX idx_attempts_job_ordinal ON job_attempts(job_id, ordinal);
CREATE INDEX idx_events_attempt_sequence ON job_events(attempt_id, sequence);
CREATE INDEX idx_artifacts_attempt ON artifacts(attempt_id);
CREATE INDEX idx_snapshots_expires_at ON snapshots(expires_at);
`,
    down: `
DROP INDEX IF EXISTS idx_snapshots_expires_at;
DROP INDEX IF EXISTS idx_artifacts_attempt;
DROP INDEX IF EXISTS idx_events_attempt_sequence;
DROP INDEX IF EXISTS idx_attempts_job_ordinal;
DROP INDEX IF EXISTS idx_jobs_state_queued_at;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS job_events;
DROP TABLE IF EXISTS job_attempts;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS job_submissions;
DROP TABLE IF EXISTS agents;
`,
  },
  {
    version: 2,
    name: 'pairing-and-credentials',
    up: `
CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY,
  device_public_key TEXT NOT NULL,
  device_thumbprint TEXT NOT NULL,
  display_name TEXT NOT NULL,
  hostname TEXT,
  metadata_json TEXT,
  one_time_code TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'claimed', 'rejected', 'expired')),
  agent_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_pairing_state ON pairing_requests(state, device_thumbprint);

ALTER TABLE agents ADD COLUMN device_public_key TEXT;
ALTER TABLE agents ADD COLUMN device_thumbprint TEXT;
ALTER TABLE agents ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN revoked_at TEXT;
`,
    down: `
DROP INDEX IF EXISTS idx_pairing_state;
DROP TABLE IF EXISTS pairing_requests;
ALTER TABLE agents DROP COLUMN revoked_at;
ALTER TABLE agents DROP COLUMN credential_version;
ALTER TABLE agents DROP COLUMN device_thumbprint;
ALTER TABLE agents DROP COLUMN device_public_key;
`,
  },
  {
    version: 3,
    name: 'phase6-attempt-recovery',
    up: `
ALTER TABLE job_attempts ADD COLUMN log_acked_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_attempts ADD COLUMN orphaned_at TEXT;
ALTER TABLE job_attempts ADD COLUMN process_identity TEXT;
ALTER TABLE job_attempts ADD COLUMN last_reconcile_at TEXT;
`,
    down: `
-- SQLite cannot DROP COLUMN portably in all versions used here; no-op downgrade.
`,
  },
  {
    version: 4,
    name: 'agent-boot-id',
    up: `
ALTER TABLE agents ADD COLUMN last_boot_id TEXT;
`,
    down: `
-- SQLite cannot DROP COLUMN portably in all versions used here; no-op downgrade.
`,
  },
];
