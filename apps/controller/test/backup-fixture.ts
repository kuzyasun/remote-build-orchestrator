import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type BackupManifest, createBackupManifest, ensureControllerIdentity } from '@rbo/shared';
import { migrateUp, openDatabase } from '../src/storage/database.js';

export function writeBackupDatabase(stagingDir: string, schemaVersion: number): void {
  const db = openDatabase(join(stagingDir, 'controller.sqlite'));
  try {
    migrateUp(db, schemaVersion);
  } finally {
    db.close();
  }
}

export async function writeMinimalBackupFixture(
  stagingDir: string,
  schemaVersion: number,
  controllerId = 'ctrl_test',
): Promise<BackupManifest> {
  await ensureControllerIdentity(stagingDir);
  writeBackupDatabase(stagingDir, schemaVersion);
  await writeFile(
    join(stagingDir, 'security', 'controller.json'),
    JSON.stringify({ controller_id: controllerId }),
  );
  return createBackupManifest(stagingDir, schemaVersion, controllerId);
}
