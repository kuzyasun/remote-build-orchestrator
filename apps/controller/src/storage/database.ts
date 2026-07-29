import { RboError, createLogger } from '@rbo/shared';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type ControllerDatabase = Database.Database;

const logger = createLogger('controller.storage');

export function openDatabase(file: string): ControllerDatabase {
  const db = new Database(file);
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  return db;
}

export function getSchemaVersion(db: ControllerDatabase): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function setSchemaVersion(db: ControllerDatabase, version: number): void {
  db.pragma(`user_version = ${version}`);
}

export function migrateToLatest(db: ControllerDatabase): void {
  const target = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  migrateUp(db, target);
}

export function migrateUp(db: ControllerDatabase, targetVersion: number): void {
  const current = getSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current || migration.version > targetVersion) {
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.up);
      setSchemaVersion(db, migration.version);
    });
    apply();
    logger.info('migration applied', { version: migration.version, name: migration.name });
  }
}

export function migrateDown(db: ControllerDatabase, targetVersion: number): void {
  const current = getSchemaVersion(db);
  if (targetVersion > current) {
    throw RboError.validation(
      `Cannot downgrade to version ${targetVersion}: current version is ${current}`,
    );
  }
  const toRevert = [...MIGRATIONS]
    .filter((m) => m.version <= current && m.version > targetVersion)
    .sort((a, b) => b.version - a.version);
  for (const migration of toRevert) {
    const revert = db.transaction(() => {
      db.exec(migration.down);
      setSchemaVersion(db, migration.version - 1);
    });
    revert();
    logger.info('migration reverted', { version: migration.version, name: migration.name });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
