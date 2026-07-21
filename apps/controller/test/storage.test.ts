import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RBO_CONTROLLER_SCHEMA_VERSION } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSchemaVersion,
  migrateDown,
  migrateToLatest,
  openDatabase,
} from '../src/storage/database.js';
import { MIGRATIONS } from '../src/storage/migrations.js';

const REQUIRED_TABLES = [
  'agents',
  'job_submissions',
  'jobs',
  'job_attempts',
  'job_events',
  'snapshots',
  'artifacts',
];

function listTables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('Controller persistence (Section 25, Phase 1)', () => {
  it('keeps @rbo/shared RBO_CONTROLLER_SCHEMA_VERSION in sync with MIGRATIONS.length', () => {
    // apps/cli validates a restore against RBO_CONTROLLER_SCHEMA_VERSION without importing
    // MIGRATIONS directly (cross-app source imports aren't supported by this repo's tsconfig
    // rootDir layout) — this guard fails loudly the moment someone adds a migration here without
    // bumping the shared constant, instead of the two silently drifting apart.
    expect(RBO_CONTROLLER_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  const tempDirs: string[] = [];

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-db-'));
    tempDirs.push(dir);
    return join(dir, 'controller.db');
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a fresh database to the latest version with all §25.2 tables', () => {
    const db = openDatabase(tempDbPath());
    migrateToLatest(db);

    expect(getSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    const tables = listTables(db);
    for (const table of REQUIRED_TABLES) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it('creates the required indexes from §25.2', () => {
    const db = openDatabase(tempDbPath());
    migrateToLatest(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const idx of [
      'idx_jobs_state_queued_at',
      'idx_attempts_job_ordinal',
      'idx_events_attempt_sequence',
      'idx_artifacts_attempt',
      'idx_snapshots_expires_at',
    ]) {
      expect(indexes).toContain(idx);
    }
    db.close();
  });

  it('supports downgrade back to an empty schema and re-upgrade', () => {
    const db = openDatabase(tempDbPath());
    migrateToLatest(db);
    migrateDown(db, 0);

    expect(getSchemaVersion(db)).toBe(0);
    expect(listTables(db)).toHaveLength(0);

    migrateToLatest(db);
    const tables = listTables(db);
    for (const table of REQUIRED_TABLES) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(tempDbPath());
    migrateToLatest(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at) VALUES ('art_x', 'job_missing', 'att_missing', 'a', 'p', 1, 'h', 'now')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});
