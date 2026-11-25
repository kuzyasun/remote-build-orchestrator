import { appendFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { CollectedArtifactFile } from '@rbo/executor';
import { moveArtifactToStore } from '@rbo/executor';
import { RboError, generateId, isPathContained, resolveRealPath } from '@rbo/shared';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import { publishPosixArtifact, publishWindowsArtifact } from './artifact-publication.js';

function containsCanonicalDestination(root: string, destination: string): boolean {
  if (process.platform !== 'win32') return isPathContained(root, destination);
  // Windows supports case-sensitive directories. The canonical paths from realpath
  // already contain the on-disk spelling, so compare whole path components as-is.
  const prefix = root.endsWith('\\') ? root : `${root}\\`;
  return destination === root || destination.startsWith(prefix);
}

export async function persistCollectedArtifacts(input: {
  db: ControllerDatabase;
  jobId: string;
  attemptId: string;
  artifactsDir: string;
  files: CollectedArtifactFile[];
}): Promise<Array<{ id: string; logical_name: string; size_bytes: number; sha256: string }>> {
  const results: Array<{ id: string; logical_name: string; size_bytes: number; sha256: string }> =
    [];
  for (const file of input.files) {
    const artifactId = generateId('art');
    const destPath = join(input.artifactsDir, artifactId);
    await moveArtifactToStore(file.sourcePath, destPath);
    const timestamp = nowIso();
    input.db
      .prepare(
        `INSERT INTO artifacts (
          id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        input.jobId,
        input.attemptId,
        file.logical_name,
        destPath,
        file.size_bytes,
        file.sha256,
        timestamp,
      );
    results.push({
      id: artifactId,
      logical_name: file.logical_name,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
    });
  }
  return results;
}

export function listArtifactsForJob(
  db: ControllerDatabase,
  jobId: string,
): Array<{
  id: string;
  attempt_id: string;
  logical_name: string;
  size_bytes: number;
  sha256: string;
}> {
  const rows = db
    .prepare(
      `SELECT id, attempt_id, logical_name, size_bytes, sha256
       FROM artifacts WHERE job_id = ? ORDER BY attempt_id, logical_name`,
    )
    .all(jobId);
  return rows as Array<{
    id: string;
    attempt_id: string;
    logical_name: string;
    size_bytes: number;
    sha256: string;
  }>;
}

export async function materializeArtifactToDestination(input: {
  db: ControllerDatabase;
  artifactId: string;
  destinationPath: string;
  allowedDestinations: string[];
  overwrite: boolean;
  clientId?: string;
  dataDir?: string;
}): Promise<{ destination_path: string; sha256: string }> {
  const row = input.db
    .prepare('SELECT path, sha256, attempt_id FROM artifacts WHERE id = ?')
    .get(input.artifactId) as { path: string; sha256: string; attempt_id: string } | undefined;
  if (!row) {
    throw new Error(`Unknown artifact_id '${input.artifactId}'`);
  }

  const destinationPath = resolve(input.destinationPath);
  const destinationParent = dirname(destinationPath);
  let realDestParent: string;
  let destinationParentIdentity: { dev: bigint; ino: bigint };
  try {
    realDestParent = await resolveRealPath(destinationParent);
    const parent = await stat(realDestParent, { bigint: true });
    if (!parent.isDirectory()) {
      throw new RboError(
        'materialization',
        `Destination parent is not a directory: ${destinationParent}`,
      );
    }
    destinationParentIdentity = parent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RboError(
        'materialization',
        `Destination parent directory does not exist: ${destinationParent}. Create it before materializing.`,
        false,
        { destination_path: destinationPath, destination_parent: destinationParent },
      );
    }
    throw error;
  }
  let allowed = false;
  const resolvedAllowedRoots: string[] = [];
  const unavailableAllowedRoots: string[] = [];
  for (const root of input.allowedDestinations) {
    let realRoot: string;
    try {
      realRoot = await resolveRealPath(root);
    } catch {
      unavailableAllowedRoots.push(root);
      continue;
    }
    resolvedAllowedRoots.push(realRoot);
    // Authorize the exact canonical pathname that the publisher will verify.
    if (containsCanonicalDestination(realRoot, realDestParent)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    throw new RboError(
      'materialization',
      'Destination path is outside allowed artifact destinations',
      false,
      {
        destination_path: destinationPath,
        resolved_parent: realDestParent,
        allowed_destinations: input.allowedDestinations,
        resolved_allowed_roots: resolvedAllowedRoots,
        unavailable_allowed_roots: unavailableAllowedRoots,
      },
    );
  }

  const publish = process.platform === 'win32' ? publishWindowsArtifact : publishPosixArtifact;
  await publish({
    parentPath: realDestParent,
    parentIdentity: destinationParentIdentity,
    sourcePath: row.path,
    destinationName: basename(destinationPath),
    sha256: row.sha256,
    overwrite: input.overwrite,
  });

  if (input.dataDir) {
    const auditDir = join(input.dataDir, 'audit');
    await mkdir(auditDir, { recursive: true });
    const auditLine = JSON.stringify({
      type: 'artifact_materialize',
      created_at: nowIso(),
      client_id: input.clientId ?? null,
      artifact_id: input.artifactId,
      attempt_id: row.attempt_id,
      destination: input.destinationPath,
      sha256: row.sha256,
    });
    await appendFile(join(auditDir, 'artifact-materialize.jsonl'), `${auditLine}\n`);
  }

  return { destination_path: input.destinationPath, sha256: row.sha256 };
}
