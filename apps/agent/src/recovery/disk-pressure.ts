import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@rbo/shared';
import {
  type AttemptMetadata,
  type AttemptMetadataStatus,
  listAttemptMetadata,
} from './attempt-metadata.js';

const logger = createLogger('agent.disk-pressure');

export type DiskCleanupKind = 'artifacts' | 'workspaces' | 'spools' | 'repos' | 'build_caches';

const ACTIVE_STATUSES: ReadonlySet<AttemptMetadataStatus> = new Set([
  'accepted',
  'running',
  'completed_awaiting_upload',
  'orphaned',
]);

export interface DiskPressureAdmissionInput {
  freeBytes: number;
  minFreeBytes: number;
  spoolPressure: boolean;
}

/** True when the Agent should accept new leases (no disk/spool pressure). */
export function isAcceptingJobsUnderDiskPressure(input: DiskPressureAdmissionInput): boolean {
  if (input.spoolPressure) {
    return false;
  }
  return input.freeBytes >= input.minFreeBytes;
}

export interface DiskPressureCleanupOptions {
  stateDir: string;
  /** Bare mirror cache directory (defaults to stateDir/repos when omitted). */
  reposDir?: string;
  minFreeBytes: number;
  /** Injectable free-disk reading for tests. */
  freeBytes: number;
  /** Age threshold for "old" terminal attempt cleanup. */
  retentionMs: number;
  /** When true, treat as under pressure even if freeBytes ≥ minFreeBytes. */
  spoolPressure?: boolean;
  nowMs?: number;
  /** Optional delete observer (tests assert order). */
  onDelete?: (kind: DiskCleanupKind, path: string) => void;
  /**
   * Label-scoped resource cleanup (e.g. Docker `rbo.attempt=<id>`) before
   * removing attempt workspaces or sweeping orphan attempt artifact dirs.
   */
  cleanupAttemptResources?: (attemptId: string) => Promise<void>;
  /** Optional repo eviction hook; default scans inactive mirrors. */
  evictInactiveRepos?: () => Promise<string[]>;
  /**
   * Optional build-cache eviction hook.
   * Runs **after** inactive repo-cache eviction (never before).
   * Must never remove keys with an active lock / in-use marker.
   */
  evictInactiveBuildCaches?: () => Promise<string[]>;
}

export interface DiskPressureCleanupResult {
  acceptingJobs: boolean;
  deletedKinds: DiskCleanupKind[];
  deletedPaths: string[];
}

function isActiveMeta(meta: AttemptMetadata): boolean {
  return ACTIVE_STATUSES.has(meta.status);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function invokeAttemptResourceCleanup(
  attemptId: string,
  cleanup?: (attemptId: string) => Promise<void>,
): Promise<void> {
  if (!cleanup) {
    return;
  }
  try {
    await cleanup(attemptId);
  } catch (error) {
    logger.warn('disk-pressure cleanupAttemptResources failed', {
      attemptId,
      error: String(error),
    });
  }
}

async function removePath(
  kind: DiskCleanupKind,
  path: string,
  onDelete?: (kind: DiskCleanupKind, path: string) => void,
): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }
  await rm(path, { recursive: true, force: true });
  onDelete?.(kind, path);
  return true;
}

/**
 * Disk-pressure cleanup order (§31.4 / Phase 6 + Phase 7):
 * refuse new leases → expired artifacts → old terminal workspaces →
 * old terminal logs/spools → inactive repo caches → inactive build caches.
 * Never removes active attempt spool/workspace/mirror, nor locked/in-use build-cache keys.
 */
export async function applyDiskPressureCleanup(
  options: DiskPressureCleanupOptions,
): Promise<DiskPressureCleanupResult> {
  const nowMs = options.nowMs ?? Date.now();
  const acceptingJobs = isAcceptingJobsUnderDiskPressure({
    freeBytes: options.freeBytes,
    minFreeBytes: options.minFreeBytes,
    spoolPressure: options.spoolPressure ?? false,
  });

  const deletedKinds: DiskCleanupKind[] = [];
  const deletedPaths: string[] = [];
  const record = (kind: DiskCleanupKind, path: string) => {
    if (!deletedKinds.includes(kind)) {
      deletedKinds.push(kind);
    }
    deletedPaths.push(path);
    options.onDelete?.(kind, path);
  };

  if (acceptingJobs) {
    return { acceptingJobs: true, deletedKinds, deletedPaths };
  }

  const allMeta = await listAttemptMetadata(options.stateDir);
  const activeIds = new Set(allMeta.filter(isActiveMeta).map((m) => m.attempt_id));
  const terminalOld = allMeta.filter(
    (m) =>
      m.status === 'terminal' &&
      nowMs - Date.parse(m.updated_at) >= options.retentionMs &&
      !activeIds.has(m.attempt_id),
  );

  // 1. Expired / old terminal artifacts
  for (const meta of terminalOld) {
    const artDir = join(options.stateDir, 'artifacts', meta.attempt_id);
    if (await removePath('artifacts', artDir, record)) {
      logger.info('disk-pressure removed expired artifacts', { attemptId: meta.attempt_id });
    }
  }
  // Also sweep artifact dirs without metadata that are not active
  const artifactsRoot = join(options.stateDir, 'artifacts');
  try {
    const entries = await readdir(artifactsRoot);
    for (const name of entries) {
      if (activeIds.has(name)) {
        continue;
      }
      const already = terminalOld.some((m) => m.attempt_id === name);
      if (already) {
        continue;
      }
      // Orphan artifact staging without active attempt — treat as expired
      const artDir = join(artifactsRoot, name);
      await invokeAttemptResourceCleanup(name, options.cleanupAttemptResources);
      if (await removePath('artifacts', artDir, record)) {
        logger.info('disk-pressure removed orphan artifacts', { attemptId: name });
      }
    }
  } catch {
    // no artifacts dir
  }

  // 2. Old terminal workspaces
  for (const meta of terminalOld) {
    await invokeAttemptResourceCleanup(meta.attempt_id, options.cleanupAttemptResources);
    const ws = meta.workspace_path ?? join(options.stateDir, 'workspaces', meta.attempt_id);
    if (await removePath('workspaces', ws, record)) {
      logger.info('disk-pressure removed old workspace', { attemptId: meta.attempt_id });
    }
  }

  // 3. Old terminal spools/logs
  for (const meta of terminalOld) {
    const spool = meta.spool_dir || join(options.stateDir, 'logs', meta.attempt_id);
    if (await removePath('spools', spool, record)) {
      logger.info('disk-pressure removed old spool', { attemptId: meta.attempt_id });
    }
  }

  // 4. Inactive repo caches
  if (options.evictInactiveRepos) {
    const evicted = await options.evictInactiveRepos();
    for (const key of evicted) {
      record('repos', join(options.reposDir ?? join(options.stateDir, 'repos'), key));
    }
  } else {
    const reposDir = options.reposDir ?? join(options.stateDir, 'repos');
    try {
      const entries = await readdir(reposDir);
      for (const name of entries) {
        const metaPath = join(reposDir, name, 'metadata.json');
        try {
          const { readFile } = await import('node:fs/promises');
          const raw = await readFile(metaPath, 'utf8');
          const meta = JSON.parse(raw) as {
            active_worktree_count?: number;
            last_used_at?: string;
          };
          if ((meta.active_worktree_count ?? 0) > 0) {
            continue;
          }
          const lastUsed = meta.last_used_at ? Date.parse(meta.last_used_at) : 0;
          if (nowMs - lastUsed < options.retentionMs) {
            continue;
          }
          const repoPath = join(reposDir, name);
          if (await removePath('repos', repoPath, record)) {
            logger.info('disk-pressure evicted inactive repo', { repoKey: name });
          }
        } catch {
          // skip broken
        }
      }
    } catch {
      // no repos dir
    }
  }

  // 5. Inactive build caches (AFTER repo caches). Never evict locked / active_users > 0.
  if (options.evictInactiveBuildCaches) {
    const evicted = await options.evictInactiveBuildCaches();
    for (const key of evicted) {
      record('build_caches', join(options.stateDir, 'build-caches', key));
    }
  }

  return { acceptingJobs: false, deletedKinds, deletedPaths };
}
