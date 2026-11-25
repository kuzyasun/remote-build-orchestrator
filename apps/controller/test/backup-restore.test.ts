import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROLLER_DATABASE_FILENAME,
  RestoreValidationError,
  applyRestoredFiles as applyFiles,
  createBackupManifest,
  ensureControllerIdentity,
  planBackup,
  recoverPendingControllerRestore,
  validateRestore,
} from '@rbo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadControllerConfig } from '../src/config.js';
import { runController } from '../src/run.js';
import { openDatabase } from '../src/storage/database.js';
import { MIGRATIONS } from '../src/storage/migrations.js';
import { validateRestoredControllerDatabase } from '../src/storage/restore-validation.js';
import { writeMinimalBackupFixture } from './backup-fixture.js';

const dirs: string[] = [];

function applyRestoredFiles(
  staging: string,
  target: string,
  manifest: Parameters<typeof applyFiles>[2],
): Promise<void> {
  return applyFiles(staging, target, manifest, validateRestoredControllerDatabase);
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    copyFile: vi.fn(real.copyFile),
    rename: vi.fn(real.rename),
    rm: vi.fn(real.rm),
  };
});

afterEach(async () => {
  vi.mocked(copyFile).mockReset();
  vi.mocked(rename).mockReset();
  vi.mocked(rm).mockReset();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Backup and restore', () => {
  it('plans backup of db, attempts, and identity', () => {
    const plan = planBackup('/data');
    expect(plan.map((p) => p.kind).sort()).toEqual(['attempts', 'database', 'identity'].sort());
    expect(plan.find((entry) => entry.kind === 'database')?.relative_path).toBe(
      CONTROLLER_DATABASE_FILENAME,
    );
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

  it('requires every identity key to be recorded in the manifest', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-unlisted-key-'));
    dirs.push(staging);
    const manifest = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    manifest.files = manifest.files.filter(
      (file) => file.relative_path !== 'security/controller-key.pem',
    );
    await writeFile(join(staging, 'BACKUP_MANIFEST.json'), JSON.stringify(manifest));

    await expect(
      validateRestore(staging, { latestSchemaVersion: MIGRATIONS.length }),
    ).rejects.toMatchObject({
      code: 'missing_file',
    });
  });

  it('rolls back previously published files when a restore cannot replace a later file', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-rollback-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-rollback-target-'));
    dirs.push(staging, target);
    const manifest = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const before = await ensureControllerIdentity(target);
    const targetDatabase = join(target, CONTROLLER_DATABASE_FILENAME);
    await writeFile(targetDatabase, 'original database');

    const { rename: realRename } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const physicalTarget = await realpath(target);
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (
        String(from).includes(`${join('payload', 'security')}`) &&
        to === join(physicalTarget, 'security', 'controller-key.pem')
      ) {
        throw new Error('destination unavailable');
      }
      return realRename(from, to);
    });

    await expect(applyRestoredFiles(staging, target, manifest)).rejects.toThrow(
      'destination unavailable',
    );
    expect(await readFile(targetDatabase, 'utf8')).toBe('original database');
    expect(await ensureControllerIdentity(target)).toMatchObject({
      fingerprint: before.fingerprint,
      tlsKeyPem: before.tlsKeyPem,
    });
  });

  it('resumes an interrupted rollback before Controller startup opens SQLite', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-interrupted-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-interrupted-target-'));
    dirs.push(staging, target);
    await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    await mkdir(join(staging, 'attempts'));
    await writeFile(join(staging, 'attempts', 'new-log'), 'restored log');
    await writeFile(join(staging, 'controller.json'), 'interrupted configuration');
    const manifest = await createBackupManifest(staging, MIGRATIONS.length, 'ctrl_test');
    manifest.files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    const before = await ensureControllerIdentity(target);
    const database = join(target, CONTROLLER_DATABASE_FILENAME);
    const certificate = join(target, 'security', 'controller-cert.pem');
    const newLog = join(target, 'attempts', 'new-log');
    const configPath = join(target, 'controller.json');
    await writeFile(database, 'original database');
    await writeFile(configPath, '{}');
    await writeFile(`${database}-wal`, 'old WAL');
    await writeFile(`${database}-shm`, 'old SHM');

    const { rename: realRename } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const physicalTarget = await realpath(target);
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === join(physicalTarget, 'security', 'controller-cert.pem')) {
        throw new Error('certificate path unavailable');
      }
      return realRename(from, to);
    });

    await expect(applyRestoredFiles(staging, target, manifest)).rejects.toThrow(
      'Restore rollback failed',
    );
    await expect(readFile(database)).resolves.toEqual(
      await readFile(join(staging, 'controller.sqlite')),
    );
    await expect(readFile(newLog, 'utf8')).resolves.toBe('restored log');
    await expect(readFile(configPath, 'utf8')).resolves.toBe('interrupted configuration');
    await expect(access(certificate)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(`${database}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(recoverPendingControllerRestore(target)).rejects.toThrow(
      'certificate path unavailable',
    );

    vi.mocked(rename).mockReset();
    await expect(
      runController({ dataDir: target, databasePath: join(target, 'missing', 'test.db') }),
    ).rejects.toThrow(/unable to open database file|directory does not exist/i);
    await recoverPendingControllerRestore(target);
    await expect(readdir(join(target, '.rbo-restore-state'))).resolves.toEqual([]);
    await expect(readFile(database, 'utf8')).resolves.toBe('original database');
    await expect(readFile(configPath, 'utf8')).resolves.toBe('{}');
    await expect(readFile(`${database}-wal`, 'utf8')).resolves.toBe('old WAL');
    await expect(readFile(`${database}-shm`, 'utf8')).resolves.toBe('old SHM');
    await expect(access(newLog)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(ensureControllerIdentity(target)).resolves.toMatchObject({
      controllerId: before.controllerId,
      fingerprint: before.fingerprint,
    });
    await expect(readFile(join(staging, 'attempts', 'new-log'), 'utf8')).resolves.toBe(
      'restored log',
    );
  });

  it('keeps committed files when temporary restore cleanup is interrupted', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-committed-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-committed-target-'));
    dirs.push(staging, target);
    const manifest = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const database = join(target, CONTROLLER_DATABASE_FILENAME);
    await writeFile(database, 'original database');
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup interrupted'));

    await expect(applyRestoredFiles(staging, target, manifest)).rejects.toThrow(
      'cleanup interrupted',
    );
    const state = join(target, '.rbo-restore-state');
    expect(await readdir(state)).toEqual([expect.stringMatching(/^cleanup-/)]);
    await recoverPendingControllerRestore(target);
    await recoverPendingControllerRestore(target);
    await expect(readdir(state)).resolves.toEqual([]);
    await expect(readFile(database)).resolves.toEqual(
      await readFile(join(staging, 'controller.sqlite')),
    );
  });

  it('publishes the backup database at the runtime default without old SQLite sidecars', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-db-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-db-target-'));
    dirs.push(staging, target);
    const fixture = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const backupDatabase = join(staging, 'controller.sqlite');
    const stagedDb = openDatabase(backupDatabase);
    try {
      stagedDb.exec(
        "CREATE TABLE restore_fixture (value TEXT); INSERT INTO restore_fixture VALUES ('backup');",
      );
    } finally {
      stagedDb.close();
    }
    const manifest = await createBackupManifest(staging, MIGRATIONS.length, fixture.controller_id);
    const { databasePath } = loadControllerConfig({ dataDir: target });
    await writeFile(databasePath, 'old database');
    for (const suffix of ['wal', 'shm', 'journal']) {
      await writeFile(`${databasePath}-${suffix}`, `old ${suffix}`);
    }

    await applyRestoredFiles(staging, target, manifest);
    for (const suffix of ['wal', 'shm', 'journal']) {
      await expect(access(`${databasePath}-${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(access(join(target, 'controller.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const restoredDb = openDatabase(databasePath);
    try {
      expect(restoredDb.prepare('SELECT value FROM restore_fixture').get()).toEqual({
        value: 'backup',
      });
    } finally {
      restoredDb.close();
    }
  });

  it('rejects a linked restore journal directory without changing its target', async (ctx) => {
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-linked-target-'));
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-linked-src-'));
    dirs.push(target, staging);
    const state = join(target, '.rbo-restore-state');
    await mkdir(state);
    try {
      await symlink(staging, join(state, 'active'), 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') ctx.skip();
      throw error;
    }
    await writeFile(join(staging, 'untouched'), 'operator file');

    await expect(recoverPendingControllerRestore(target)).rejects.toThrow(
      'Unsafe restore directory',
    );
    await expect(readFile(join(staging, 'untouched'), 'utf8')).resolves.toBe('operator file');
  });

  it('rejects manifest paths that alias on the destination filesystem before publishing files', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-alias-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-alias-target-'));
    dirs.push(staging, target);
    const manifest = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const metadata = manifest.files.find(
      (file) => file.relative_path === 'security/controller.json',
    );
    if (!metadata) throw new Error('fixture metadata missing');
    manifest.files.push({ ...metadata, relative_path: 'security/CONTROLLER.JSON' });
    const database = join(target, CONTROLLER_DATABASE_FILENAME);
    await writeFile(database, 'preserve this original');

    let caseInsensitive = false;
    const probe = join(target, 'case-sensitivity-probe');
    await writeFile(probe, 'probe');
    try {
      await access(join(target, 'CASE-SENSITIVITY-PROBE'));
      caseInsensitive = true;
    } catch {
      // This filesystem keeps the two names separate; the alias cannot be reproduced here.
    }
    if (!caseInsensitive && process.platform !== 'win32') return;

    await expect(applyRestoredFiles(staging, target, manifest)).rejects.toThrow();
    expect(await readFile(database, 'utf8')).toBe('preserve this original');
  });

  it('keeps live files intact when the destination filesystem rejects an exclusive staging copy', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-copy-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-copy-target-'));
    dirs.push(staging, target);
    const manifest = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const existing = join(target, CONTROLLER_DATABASE_FILENAME);
    await writeFile(existing, 'preserve this original');

    const { copyFile: realCopyFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(copyFile).mockImplementation(async (from, to, mode) => {
      if (String(to).endsWith(join('payload', 'security', 'controller-key.pem'))) {
        expect(mode).toBe(constants.COPYFILE_EXCL);
        throw Object.assign(new Error('staging path exists'), { code: 'EEXIST' });
      }
      await realCopyFile(from, to, mode);
    });

    await expect(applyRestoredFiles(staging, target, manifest)).rejects.toThrow(
      'staging path exists',
    );
    expect(await readFile(existing, 'utf8')).toBe('preserve this original');
    expect(rename).not.toHaveBeenCalled();
  });

  it('rechecks the private database bytes after validation before publishing', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-validate-src-'));
    const target = await mkdtemp(join(tmpdir(), 'rbo-restore-validate-target-'));
    dirs.push(staging, target);
    const manifest = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    const database = join(target, CONTROLLER_DATABASE_FILENAME);
    await writeFile(database, 'original database');

    await expect(
      applyFiles(staging, target, manifest, async (path, version) => {
        await validateRestoredControllerDatabase(path, version);
        await writeFile(path, 'changed during database validation');
      }),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
    await expect(readFile(database, 'utf8')).resolves.toBe('original database');
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects unsupported downgrade from a future schema', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'rbo-restore-future-'));
    dirs.push(staging);
    const { controller_id } = await writeMinimalBackupFixture(staging, MIGRATIONS.length);
    await createBackupManifest(staging, MIGRATIONS.length + 5, controller_id);
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
