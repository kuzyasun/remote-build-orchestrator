import type { Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
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

function isRecoverableSnapshotFile(name: string): boolean {
  return PRIVATE_CANDIDATE_NAME.test(name) || GENERATION_FINAL_NAME.test(name);
}

async function listSnapshotDirectories(snapshotsRoot: string): Promise<Dirent[] | null> {
  try {
    return await readdir(snapshotsRoot, { withFileTypes: true });
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
  const directories = await listSnapshotDirectories(snapshotsRoot);
  if (!directories) {
    return { skippedForActiveLease: false, removedFiles: 0, removedDirectories: 0 };
  }

  let removedFiles = 0;
  let removedDirectories = 0;
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(snapshotsRoot, directory.name);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isRecoverableSnapshotFile(entry.name)) continue;
      const path = resolve(directoryPath, entry.name);
      const generation = generationForName(entry.name);
      if (
        referenced.paths.has(path) ||
        (generation !== null &&
          referenced.generations.has(generationKey(directoryPath, generation)))
      ) {
        continue;
      }
      await rm(path, { force: true });
      removedFiles += 1;
    }

    const remaining = await readdir(directoryPath);
    if (remaining.length === 0) {
      await rm(directoryPath, { recursive: true, force: true });
      removedDirectories += 1;
    }
  }

  logger.info('snapshot publication recovery complete', { removedFiles, removedDirectories });
  return { skippedForActiveLease: false, removedFiles, removedDirectories };
}
