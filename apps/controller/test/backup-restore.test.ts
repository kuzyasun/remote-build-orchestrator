import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RestoreValidationError,
  planBackup,
  validateRestore,
  writeMinimalBackupFixture,
} from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/storage/migrations.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Backup and restore', () => {
  it('plans backup of db, attempts, and identity', () => {
    const plan = planBackup('/data');
    expect(plan.map((p) => p.kind).sort()).toEqual(['attempts', 'database', 'identity'].sort());
  });

  it('validates a complete restore staging directory', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-ok-'));
    dirs.push(staging);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const manifest = await validateRestore(staging, {
      latestSchemaVersion: MIGRATIONS.length,
    });
    expect(manifest.controller_schema_version).toBe(MIGRATIONS.length);
  });

  it('rejects hash mismatch', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-bad-'));
    dirs.push(staging);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    await writeFile(join(staging, 'controller.sqlite'), 'tampered');
    await expect(
      validateRestore(staging, { latestSchemaVersion: MIGRATIONS.length }),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  it('rejects unsupported downgrade from a future schema', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-future-'));
    dirs.push(staging);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length + 5);
    try {
      await validateRestore(staging, { latestSchemaVersion: MIGRATIONS.length });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreValidationError);
      expect((error as RestoreValidationError).code).toBe('unsupported_downgrade');
    }
  });

  it('accepts restore when the backup controller_id matches the target controller', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-own-match-'));
    dirs.push(staging);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length, 'ctrl_abc123');
    const manifest = await validateRestore(staging, {
      latestSchemaVersion: MIGRATIONS.length,
      expectedControllerId: 'ctrl_abc123',
    });
    expect(manifest.controller_id).toBe('ctrl_abc123');
  });

  it('rejects restore of a backup that belongs to a different controller (ownership_mismatch)', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-own-mismatch-'));
    dirs.push(staging);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length, 'ctrl_other_machine');
    await expect(
      validateRestore(staging, {
        latestSchemaVersion: MIGRATIONS.length,
        expectedControllerId: 'ctrl_this_machine',
      }),
    ).rejects.toMatchObject({ code: 'ownership_mismatch' });
  });

  it('allows restore without an ownership check onto a fresh data dir with no prior identity', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-fresh-'));
    dirs.push(staging);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length, 'ctrl_any');
    // expectedControllerId omitted: no existing identity to compare against yet.
    const manifest = await validateRestore(staging, { latestSchemaVersion: MIGRATIONS.length });
    expect(manifest.controller_id).toBe('ctrl_any');
  });

  it('backup-restore docs forbid copying agent private keys', async () => {
    const doc = await readFile(join(process.cwd(), 'docs', 'user', 'backup-restore.md'), 'utf8');
    expect(doc.toLowerCase()).toMatch(/never copy agent private keys/);
    expect(doc.toLowerCase()).toMatch(/revoke/);
    expect(doc.toLowerCase()).toMatch(/re-pair|repair|pair/);
  });
});
