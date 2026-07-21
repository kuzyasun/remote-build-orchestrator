/**
 * Controller backup/restore planning and validation (Phase 8).
 * Identity material is included only via an operator-protected backup path.
 * Lives in @rbo/shared (not apps/controller) so apps/cli can validate a restore
 * before starting the Controller without a cross-app source import.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BackupPlanEntry {
  relative_path: string;
  required: boolean;
  kind: 'database' | 'attempts' | 'identity' | 'other';
}

export interface BackupManifest {
  schema_version: 1;
  created_at: string;
  controller_schema_version: number;
  controller_id: string;
  files: Array<{ relative_path: string; sha256: string; size_bytes: number }>;
}

export function planBackup(_dataDir: string): BackupPlanEntry[] {
  return [
    { relative_path: 'controller.sqlite', required: true, kind: 'database' },
    { relative_path: 'attempts', required: false, kind: 'attempts' },
    { relative_path: 'identity', required: true, kind: 'identity' },
  ];
}

export async function createBackupManifest(
  stagingDir: string,
  controllerSchemaVersion: number,
  controllerId: string,
): Promise<BackupManifest> {
  const files: BackupManifest['files'] = [];
  async function walk(rel: string): Promise<void> {
    const abs = join(stagingDir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name).replace(/\\/g, '/') : entry.name;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else {
        const buf = await readFile(join(stagingDir, childRel));
        files.push({
          relative_path: childRel.replace(/\\/g, '/'),
          sha256: createHash('sha256').update(buf).digest('hex'),
          size_bytes: buf.length,
        });
      }
    }
  }
  await walk('');
  const manifest: BackupManifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    controller_schema_version: controllerSchemaVersion,
    controller_id: controllerId,
    files,
  };
  await writeFile(
    join(stagingDir, 'BACKUP_MANIFEST.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export class RestoreValidationError extends Error {
  readonly code:
    | 'missing_file'
    | 'hash_mismatch'
    | 'unsupported_downgrade'
    | 'missing_manifest'
    | 'ownership_mismatch';

  constructor(code: RestoreValidationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Validate a restore staging directory before starting the Controller.
 * Fails closed on missing required files, hash mismatch, ownership mismatch, or unsupported
 * schema downgrade. Pass `expectedControllerId` (the target machine's current, already-provisioned
 * Controller identity) whenever restoring onto a data dir that already has one — this rejects
 * restoring a different Controller's backup over it silently. Omit it only for a genuinely fresh
 * data dir with no prior identity, where the backup is establishing ownership for the first time.
 */
export async function validateRestore(
  stagingDir: string,
  options: {
    latestSchemaVersion: number;
    allowDowngrade?: boolean;
    expectedControllerId?: string;
  },
): Promise<BackupManifest> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(stagingDir, 'BACKUP_MANIFEST.json'), 'utf8'));
  } catch {
    throw new RestoreValidationError('missing_manifest', 'BACKUP_MANIFEST.json missing');
  }

  if (
    options.expectedControllerId !== undefined &&
    manifest.controller_id !== options.expectedControllerId
  ) {
    throw new RestoreValidationError(
      'ownership_mismatch',
      `Backup belongs to controller_id '${manifest.controller_id}', not the target controller '${options.expectedControllerId}'`,
    );
  }

  if (manifest.controller_schema_version > options.latestSchemaVersion) {
    throw new RestoreValidationError(
      'unsupported_downgrade',
      `Backup schema ${manifest.controller_schema_version} is newer than supported ${options.latestSchemaVersion}`,
    );
  }
  if (
    options.allowDowngrade === false &&
    manifest.controller_schema_version < options.latestSchemaVersion
  ) {
    // Forward restore (old backup → newer code) is OK; explicit unsupported downgrade
    // of running DB is handled elsewhere. Here we only block future→past binary.
  }

  for (const file of manifest.files) {
    const abs = join(stagingDir, file.relative_path);
    try {
      await stat(abs);
    } catch {
      throw new RestoreValidationError('missing_file', `Missing ${file.relative_path}`);
    }
    const buf = await readFile(abs);
    const hash = createHash('sha256').update(buf).digest('hex');
    if (hash !== file.sha256) {
      throw new RestoreValidationError('hash_mismatch', `Hash mismatch for ${file.relative_path}`);
    }
  }

  const required = ['controller.sqlite', 'identity'];
  for (const req of required) {
    const found = manifest.files.some(
      (f) => f.relative_path === req || f.relative_path.startsWith(`${req}/`),
    );
    if (!found) {
      try {
        await stat(join(stagingDir, req));
      } catch {
        throw new RestoreValidationError('missing_file', `Required path missing: ${req}`);
      }
    }
  }

  return manifest;
}

/** Copy every manifest-listed file from a validated staging dir into the live data dir. */
export async function applyRestoredFiles(
  stagingDir: string,
  dataDir: string,
  manifest: BackupManifest,
): Promise<void> {
  for (const file of manifest.files) {
    const src = join(stagingDir, file.relative_path);
    const dest = join(dataDir, file.relative_path);
    await mkdir(join(dest, '..'), { recursive: true });
    const buf = await readFile(src);
    await writeFile(dest, buf);
  }
}

export async function writeMinimalBackupFixture(
  stagingDir: string,
  schemaVersion: number,
  controllerId = 'ctrl_test',
): Promise<BackupManifest> {
  await mkdir(join(stagingDir, 'identity'), { recursive: true });
  await writeFile(join(stagingDir, 'controller.sqlite'), 'sqlite-fixture');
  await writeFile(join(stagingDir, 'identity', 'controller-id.txt'), controllerId);
  return createBackupManifest(stagingDir, schemaVersion, controllerId);
}
