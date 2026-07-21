import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ErrorCategory } from '@rbo/shared';

export type AttemptMetadataStatus =
  | 'accepted'
  | 'running'
  | 'completed_awaiting_upload'
  | 'orphaned'
  | 'terminal';

/** Persisted so adopt can re-send job_exit after disconnect. */
export interface AttemptExitRecord {
  exit_code: number | null;
  outcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost';
  failure_category?: ErrorCategory;
  failure_message?: string;
}

/** Hash-verified staging entry — resume uploads from these paths only (never re-glob). */
export interface AttemptArtifactManifestItem {
  logical_name: string;
  /** Absolute path under `{stateDir}/artifacts/<attempt-id>/`. */
  path: string;
  size_bytes: number;
  sha256: string;
}

export interface AttemptMetadata {
  attempt_id: string;
  job_id: string;
  lease_id: string;
  lease_epoch: number;
  process_identity: string | null;
  status: AttemptMetadataStatus;
  workspace_path: string | null;
  spool_dir: string;
  risk_level: 'safe' | 'normal' | 'destructive' | 'hardware';
  updated_at: string;
  /** Set when process exits; used to re-send job_exit on adopt. */
  last_exit?: AttemptExitRecord;
  /** Absolute ISO lease deadline tracked locally for destructive/hardware self-term. */
  lease_deadline?: string;
  /** Persisted after collect; resume re-sends this manifest without re-collection. */
  artifact_manifest?: AttemptArtifactManifestItem[];
}

export function attemptMetadataDir(stateDir: string, attemptId: string): string {
  return join(stateDir, 'attempts', attemptId);
}

export function attemptMetadataPath(stateDir: string, attemptId: string): string {
  return join(attemptMetadataDir(stateDir, attemptId), 'metadata.json');
}

/** Atomic write of attempt metadata.json under `{stateDir}/attempts/<id>/`. */
export function writeAttemptMetadata(stateDir: string, meta: AttemptMetadata): void {
  const dir = attemptMetadataDir(stateDir, meta.attempt_id);
  mkdirSync(dir, { recursive: true });
  const target = attemptMetadataPath(stateDir, meta.attempt_id);
  const tmp = `${target}.${process.pid}.tmp`;
  const payload: AttemptMetadata = {
    ...meta,
    updated_at: meta.updated_at || new Date().toISOString(),
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}

export function readAttemptMetadata(stateDir: string, attemptId: string): AttemptMetadata | null {
  const path = attemptMetadataPath(stateDir, attemptId);
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as AttemptMetadata;
  } catch {
    return null;
  }
}

/** Scan attempt metadata.json under stateDir/attempts. */
export async function listAttemptMetadata(stateDir: string): Promise<AttemptMetadata[]> {
  const root = join(stateDir, 'attempts');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: AttemptMetadata[] = [];
  for (const name of entries) {
    const meta = readAttemptMetadata(stateDir, name);
    if (meta) {
      out.push(meta);
    }
  }
  return out;
}

export async function removeAttemptMetadata(stateDir: string, attemptId: string): Promise<void> {
  await rm(attemptMetadataDir(stateDir, attemptId), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

export { processIdentityFromPid } from '@rbo/shared';

/** Ensure parent dir exists (used when only creating spool path references). */
export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
