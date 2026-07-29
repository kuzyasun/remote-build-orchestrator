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

describe('Migration v4 — agent boot_id', () => {
  const tempDirs: string[] = [];

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-mig-v4-'));
    tempDirs.push(dir);
    return join(dir, 'controller.db');
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds last_boot_id to agents and defaults to NULL', () => {
    const db = openDatabase(tempDbPath());
    try {
      migrateToLatest(db);

      expect(getSchemaVersion(db)).toBe(4);

      const columns = listColumnNames(db, 'agents');
      expect(columns).toContain('last_boot_id');

      // Insert an agent and confirm the column is nullable / defaults to NULL.
      db.prepare(
        `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
         VALUES ('agt_v4', 'agt_v4', 'localhost', 'offline', '{}', '2026-01-01T00:00:00Z')`,
      ).run();
      const row = db.prepare('SELECT last_boot_id FROM agents WHERE id = ?').get('agt_v4') as {
        last_boot_id: string | null;
      };
      expect(row.last_boot_id).toBeNull();

      // UPDATE path used by updateAgentCapabilities works.
      db.prepare('UPDATE agents SET last_boot_id = ? WHERE id = ?').run('boot_xyz', 'agt_v4');
      const after = db.prepare('SELECT last_boot_id FROM agents WHERE id = ?').get('agt_v4') as {
        last_boot_id: string | null;
      };
      expect(after.last_boot_id).toBe('boot_xyz');
    } finally {
      db.close();
    }
  });
});
