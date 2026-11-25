import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RestoreValidationError } from '@rbo/shared';
import Database from 'better-sqlite3';
import {
  type ControllerDatabase,
  getSchemaVersion,
  migrateToLatest,
  openDatabase,
} from './database.js';
import { MIGRATIONS } from './migrations.js';

const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;

function controllerSchema(db: ControllerDatabase): Map<string, string> {
  const objects = db
    .prepare<[], { type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'",
    )
    .all();
  return new Map(objects.map(({ type, name, sql }) => [`${type} ${name}`, sql]));
}

function verifyControllerSchema(db: ControllerDatabase): void {
  const expected = openDatabase(':memory:');
  try {
    for (const migration of MIGRATIONS) expected.exec(migration.up);
    const actual = controllerSchema(db);
    for (const [object, sql] of controllerSchema(expected)) {
      if (actual.get(object) !== sql) {
        throw new RestoreValidationError(
          'invalid_database',
          `Invalid Controller schema: ${object}`,
        );
      }
    }
  } finally {
    expected.close();
  }
}

function verifyForeignKeys(db: ControllerDatabase, description: string): void {
  const violation = db
    .prepare<[], { table: string; parent: string }>('PRAGMA main.foreign_key_check')
    .get();
  if (violation) {
    throw new RestoreValidationError(
      'invalid_database',
      `${description} failed foreign key check: ${JSON.stringify(violation.table)} references ${JSON.stringify(violation.parent)}`,
    );
  }
}

/** Validate the copied backup database before any live restore files are moved. */
export async function validateRestoredControllerDatabase(
  file: string,
  declaredVersion: number,
): Promise<void> {
  try {
    // SQLite's read-only connections omit some integrity checks. Only this private,
    // hash-verified copy can be opened here; the caller checks its bytes again afterward.
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma('trusted_schema = OFF');
      const version = getSchemaVersion(db);
      if (version !== declaredVersion) {
        throw new RestoreValidationError(
          'invalid_database',
          `Backup database schema ${version} does not match manifest schema ${declaredVersion}`,
        );
      }
      if (version !== 0 && !MIGRATIONS.some((migration) => migration.version === version)) {
        throw new RestoreValidationError(
          'unsupported_downgrade',
          `Backup database schema ${version} is unsupported`,
        );
      }
      if (
        db.pragma('page_count', { simple: true }) === 0 ||
        db.pragma('integrity_check(1)', { simple: true }) !== 'ok'
      ) {
        throw new RestoreValidationError(
          'invalid_database',
          'Backup database failed integrity check',
        );
      }
      verifyForeignKeys(db, 'Backup database');
      if (version === latestVersion) {
        verifyControllerSchema(db);
        return;
      }
    } finally {
      db.close();
    }

    // Exercise the real startup migrations without modifying the bytes recorded in the manifest.
    const scratchDir = await mkdtemp(join(dirname(file), '.rbo-db-check-'));
    try {
      const scratchFile = join(scratchDir, 'controller.db');
      await copyFile(file, scratchFile);
      const scratch = openDatabase(scratchFile);
      try {
        scratch.pragma('trusted_schema = OFF');
        migrateToLatest(scratch);
        verifyControllerSchema(scratch);
        verifyForeignKeys(scratch, 'Migrated backup database');
      } finally {
        scratch.close();
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new RestoreValidationError(
      'invalid_database',
      `Cannot validate backup database: ${detail}`,
    );
  }
}
