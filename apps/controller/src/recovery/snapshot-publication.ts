import type { Dirent } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createLogger } from '@rbo/shared';
import type { ControllerDatabase } from '../storage/database.js';

const logger = createLogger('controller.snapshot-recovery');

const PRIVATE_CANDIDATE_NAME = /\.(?:candidate|tmp)-[A-Za-z0-9_-]+$/;
const GENERATION_FINAL_NAME =
  /^(?:full-source\.tar\.zst|overlay\.tar\.zst|manifest\.json|secret-warnings\.json|git-source-requirements\.json)\.g\d+$/;

export interface SnapshotPublicationRecoveryResult {
  skippedForActiveLease: boolean;
  removedFiles: number;
  removedDirectories: number;
}

export interface RecoverSnapshotPublicationsOptions {
  db: ControllerDatabase;
  dataDir: string;
  now?: Date;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== '' && !child.startsWith('..') && !child.startsWith('..\\') && !child.includes(':')
  );
}

function generationForName(name: string): string | null {
  return name.match(/\.g(\d+)$/)?.[1] ?? null;
}

function generationKey(directory: string, generation: string): string {
  return `${directory}\u0000${generation}`;
}

function referencedSnapshotPaths(
  db: ControllerDatabase,
  snapshotsRoot: string,
): { paths: Set<string>; generations: Set<string> } {
  const rows = db.prepare('SELECT manifest_path, payload_path FROM snapshots').all() as Array<{
    manifest_path: string;
    payload_path: string | null;
  }>;
  const paths = new Set<string>();
  const generations = new Set<string>();
  for (const row of rows) {
    for (const path of [row.manifest_path, row.payload_path]) {
      if (!path) continue;
      const resolved = resolve(path);
      if (!isWithin(snapshotsRoot, resolved)) continue;
      paths.add(resolved);
      const generation = generationForName(basename(resolved));
      if (generation) generations.add(generationKey(dirname(resolved), generation));
    }
  }
  return { paths, generations };
}

function hasActiveCaptureLease(db: ControllerDatabase, now: Date): boolean {
  return (
    db
      .prepare('SELECT 1 FROM snapshot_capture_leases WHERE lease_expires_at > ? LIMIT 1')
      .get(now.toISOString()) !== undefined
  );
}

/** Delay until the soonest live capture lease expires so startup recovery can retry. */
export function snapshotRecoveryRetryDelayMs(
  db: ControllerDatabase,
  now: Date = new Date(),
): number | undefined {
  const row = db
    .prepare(
      'SELECT MIN(lease_expires_at) AS until FROM snapshot_capture_leases WHERE lease_expires_at > ?',
    )
    .get(now.toISOString()) as { until: string | null } | undefined;
  if (!row?.until) return undefined;
  const until = Date.parse(row.until);
  if (Number.isNaN(until)) return undefined;
  return Math.max(50, until - now.getTime() + 50);
}

function isRecoverableSnapshotFile(name: string): boolean {
  return PRIVATE_CANDIDATE_NAME.test(name) || GENERATION_FINAL_NAME.test(name);
}

async function listDirectory(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Removes only private candidates and generation-scoped final files that are
 * not referenced by SQLite. Any live capture lease protects the whole snapshot
 * tree: pre-commit directories are intentionally not yet associated with a
 * database job, so narrower cleanup could race an active owner.
 */
export async function recoverSnapshotPublications(
  options: RecoverSnapshotPublicationsOptions,
): Promise<SnapshotPublicationRecoveryResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid snapshot recovery clock');

  const snapshotsRoot = resolve(options.dataDir, 'snapshots');
  if (hasActiveCaptureLease(options.db, now)) {
    logger.info('snapshot publication recovery deferred for active capture lease');
    return { skippedForActiveLease: true, removedFiles: 0, removedDirectories: 0 };
  }

  const referenced = referencedSnapshotPaths(options.db, snapshotsRoot);
  const rootEntries = await listDirectory(snapshotsRoot);
  if (!rootEntries) {
    return { skippedForActiveLease: false, removedFiles: 0, removedDirectories: 0 };
  }

  let removedFiles = 0;
  let removedDirectories = 0;
  let abortedForLease = false;
  async function recoverDirectory(directoryPath: string): Promise<void> {
    if (abortedForLease) return;
    const entries = await listDirectory(directoryPath);
    if (!entries) return;
    for (const entry of entries) {
      if (abortedForLease) return;
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await recoverDirectory(path);
        continue;
      }
      if (!entry.isFile() || !isRecoverableSnapshotFile(entry.name)) continue;
      if (hasActiveCaptureLease(options.db, new Date())) {
        logger.info('snapshot publication recovery aborted for active capture lease');
        abortedForLease = true;
        return;
      }
      const resolvedPath = resolve(path);
      const generation = generationForName(entry.name);
      const live = referencedSnapshotPaths(options.db, snapshotsRoot);
      if (
        referenced.paths.has(resolvedPath) ||
        live.paths.has(resolvedPath) ||
        (generation !== null &&
          (referenced.generations.has(generationKey(directoryPath, generation)) ||
            live.generations.has(generationKey(directoryPath, generation))))
      ) {
        continue;
      }
      await rm(path, { force: true });
      removedFiles += 1;
    }

    const remaining = await listDirectory(directoryPath);
    if (!abortedForLease && remaining?.length === 0 && directoryPath !== snapshotsRoot) {
      if (hasActiveCaptureLease(options.db, new Date())) {
        logger.info('snapshot publication recovery aborted for active capture lease');
        abortedForLease = true;
        return;
      }
      try {
        await rmdir(directoryPath);
        removedDirectories += 1;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          abortedForLease = true;
          return;
        }
        throw error;
      }
    }
  }
  for (const directory of rootEntries) {
    if (abortedForLease) break;
    if (directory.isDirectory()) await recoverDirectory(join(snapshotsRoot, directory.name));
  }

  if (abortedForLease) {
    return { skippedForActiveLease: true, removedFiles, removedDirectories };
  }

  logger.info('snapshot publication recovery complete', { removedFiles, removedDirectories });
  return { skippedForActiveLease: false, removedFiles, removedDirectories };
}
