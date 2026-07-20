import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSchemaVersion, migrateToLatest, openDatabase } from '../src/storage/database.js';

function listColumnNames(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('Migration v3 — phase6 attempt recovery columns', () => {
  const tempDirs: string[] = [];

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-mig-v3-'));
    tempDirs.push(dir);
    return join(dir, 'controller.db');
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds log_acked_sequence, orphaned_at, process_identity, last_reconcile_at to job_attempts', () => {
    const db = openDatabase(tempDbPath());
    try {
      migrateToLatest(db);

      expect(getSchemaVersion(db)).toBe(3);

      const columns = listColumnNames(db, 'job_attempts');
      expect(columns).toContain('log_acked_sequence');
      expect(columns).toContain('orphaned_at');
      expect(columns).toContain('process_identity');
      expect(columns).toContain('last_reconcile_at');
    } finally {
      db.close();
    }
  });
});
