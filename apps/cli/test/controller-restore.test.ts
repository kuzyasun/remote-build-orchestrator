import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadControllerConfig } from '@rbo/controller/config';
import {
  RBO_CONTROLLER_SCHEMA_VERSION,
  createBackupManifest,
  ensureControllerIdentity,
} from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSchemaVersion,
  migrateToLatest,
  openDatabase,
} from '../../controller/src/storage/database.js';
import {
  writeBackupDatabase,
  writeMinimalBackupFixture,
} from '../../controller/test/backup-fixture.js';
import { runControllerRestore } from '../src/commands/controller.js';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function editBackupDatabase(file: string, sql: string): void {
  const db = openDatabase(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function addUnlinkedFixtureRow(file: string): void {
  editBackupDatabase(
    file,
    `
    CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE fixture_child (parent_id INTEGER REFERENCES fixture_parent(id));
    PRAGMA foreign_keys = OFF;
    INSERT INTO fixture_child VALUES (1);
  `,
  );
}

describe('rbo controller restore (§26, runbook)', () => {
  it('restores a valid backup onto a fresh data dir with no prior identity', async () => {
    const staging = await tempDir('rbo-cli-restore-ok-');
    const dataDir = await tempDir('rbo-cli-restore-target-');
    await writeMinimalBackupFixture(staging, 3, 'ctrl_fixture_1');
    const backupIdentity = await ensureControllerIdentity(staging);

    const result = await runControllerRestore({ stagingDir: staging, dataDir });
    expect(result.ok).toBe(true);
    expect(result.controller_id).toBe('ctrl_fixture_1');
    expect(result.files_restored).toBeGreaterThan(0);

    const { databasePath } = loadControllerConfig({ dataDir });
    const stagedDatabase = await readFile(join(staging, 'controller.sqlite'));
    await expect(readFile(databasePath)).resolves.toEqual(stagedDatabase);
    const restoredDb = openDatabase(databasePath);
    try {
      expect(getSchemaVersion(restoredDb)).toBe(3);
      migrateToLatest(restoredDb);
      expect(getSchemaVersion(restoredDb)).toBe(RBO_CONTROLLER_SCHEMA_VERSION);
    } finally {
      restoredDb.close();
    }
    const restored = await ensureControllerIdentity(dataDir);
    expect(restored).toMatchObject({
      controllerId: backupIdentity.controllerId,
      fingerprint: backupIdentity.fingerprint,
      signingPublicKeyPem: backupIdentity.signingPublicKeyPem,
      mcpToken: backupIdentity.mcpToken,
    });
  });

  it("rejects restoring a different controller's backup onto an already-provisioned data dir", async () => {
    const staging = await tempDir('rbo-cli-restore-mismatch-');
    const dataDir = await tempDir('rbo-cli-restore-provisioned-');
    await ensureControllerIdentity(dataDir); // provisions a real identity in dataDir first
    await writeMinimalBackupFixture(staging, 3, 'ctrl_other_machine');

    await expect(runControllerRestore({ stagingDir: staging, dataDir })).rejects.toMatchObject({
      code: 'ownership_mismatch',
    });
  });

  it('recovers the former identity before checking ownership on a restore retry', async () => {
    const staging = await tempDir('rbo-cli-restore-retry-src-');
    const dataDir = await tempDir('rbo-cli-restore-retry-target-');
    const before = await ensureControllerIdentity(dataDir);
    const manifest = await writeMinimalBackupFixture(staging, 3, 'ctrl_other_machine');
    const active = join(dataDir, '.rbo-restore-state', 'active');
    const metadata = join(dataDir, 'security', 'controller.json');
    await cp(staging, join(active, 'payload'), { recursive: true });
    await mkdir(join(active, 'originals', 'security'), { recursive: true });
    await writeFile(
      join(active, 'journal.json'),
      JSON.stringify({
        version: 1,
        ownerPid: process.pid,
        files: manifest.files.map(({ relative_path }) => ({
          relative_path,
          hadOriginal: relative_path !== 'controller.sqlite',
        })),
        sidecars: [],
      }),
    );
    await rename(metadata, join(active, 'originals', 'security', 'controller.json'));

    await expect(runControllerRestore({ stagingDir: staging, dataDir })).rejects.toMatchObject({
      code: 'ownership_mismatch',
    });
    await expect(ensureControllerIdentity(dataDir)).resolves.toMatchObject({
      controllerId: before.controllerId,
      fingerprint: before.fingerprint,
    });
  });

  it("accepts restoring the same controller's own backup back onto its data dir", async () => {
    const staging = await tempDir('rbo-cli-restore-same-');
    const dataDir = await tempDir('rbo-cli-restore-self-');
    const identity = await ensureControllerIdentity(dataDir);
    await cp(join(dataDir, 'security'), join(staging, 'security'), { recursive: true });
    writeBackupDatabase(staging, RBO_CONTROLLER_SCHEMA_VERSION);
    await createBackupManifest(staging, RBO_CONTROLLER_SCHEMA_VERSION, identity.controllerId);

    const result = await runControllerRestore({ stagingDir: staging, dataDir });
    expect(result.controller_id).toBe(identity.controllerId);
  });

  it.each([
    {
      name: 'non-SQLite bytes',
      version: RBO_CONTROLLER_SCHEMA_VERSION,
      change: (file: string) => writeFile(file, 'not a SQLite database'),
      message: /Cannot validate backup database/,
    },
    {
      name: 'a different actual schema version',
      version: RBO_CONTROLLER_SCHEMA_VERSION,
      change: (file: string) => editBackupDatabase(file, 'PRAGMA user_version = 5'),
      message: /does not match manifest schema/,
    },
    {
      name: 'a failed integrity check',
      version: RBO_CONTROLLER_SCHEMA_VERSION,
      change: (file: string) =>
        editBackupDatabase(
          file,
          `
        CREATE TABLE restore_check_fixture (amount INTEGER CHECK (amount > 0));
        PRAGMA ignore_check_constraints = ON;
        INSERT INTO restore_check_fixture VALUES (-1);
      `,
        ),
      message: /failed integrity check/,
    },
    {
      name: 'a dangling foreign key at the current schema version',
      version: RBO_CONTROLLER_SCHEMA_VERSION,
      change: addUnlinkedFixtureRow,
      message: /failed foreign key check: "fixture_child" references "fixture_parent"/,
    },
    {
      name: 'a dangling foreign key at an older schema version',
      version: 3,
      change: addUnlinkedFixtureRow,
      message: /failed foreign key check: "fixture_child" references "fixture_parent"/,
    },
    {
      name: 'a missing Controller table at the current version',
      version: RBO_CONTROLLER_SCHEMA_VERSION,
      change: (file: string) => editBackupDatabase(file, 'DROP TABLE snapshot_capture_leases'),
      message: /Invalid Controller schema/,
    },
    {
      name: 'a failing migration from an older version',
      version: 5,
      change: (file: string) => editBackupDatabase(file, 'DROP TABLE job_attempts'),
      message: /Cannot validate backup database/,
    },
  ])(
    'preserves live files when a matching manifest contains $name',
    async ({ version, change, message }) => {
      const staging = await tempDir('rbo-cli-restore-invalid-src-');
      const dataDir = await tempDir('rbo-cli-restore-invalid-target-');
      const identity = await ensureControllerIdentity(dataDir);
      const { databasePath } = loadControllerConfig({ dataDir });
      editBackupDatabase(databasePath, 'CREATE TABLE live_fixture (id INTEGER PRIMARY KEY)');
      const originalDatabase = await readFile(databasePath);
      await writeFile(`${databasePath}-wal`, 'original sidecar');
      await writeMinimalBackupFixture(staging, version, identity.controllerId);
      await change(join(staging, 'controller.sqlite'));
      await createBackupManifest(staging, version, identity.controllerId);

      await expect(runControllerRestore({ stagingDir: staging, dataDir })).rejects.toMatchObject({
        code: 'invalid_database',
        message: expect.stringMatching(message),
      });
      await expect(readFile(databasePath)).resolves.toEqual(originalDatabase);
      await expect(readFile(`${databasePath}-wal`, 'utf8')).resolves.toBe('original sidecar');
      await expect(readdir(join(dataDir, '.rbo-restore-state'))).resolves.toEqual([]);
      await expect(ensureControllerIdentity(dataDir)).resolves.toMatchObject({
        fingerprint: identity.fingerprint,
      });
    },
  );

  it('rejects a staging dir with no BACKUP_MANIFEST.json', async () => {
    const staging = await tempDir('rbo-cli-restore-nomanifest-');
    const dataDir = await tempDir('rbo-cli-restore-nomanifest-target-');
    await writeFile(join(staging, 'controller.sqlite'), 'x');

    await expect(runControllerRestore({ stagingDir: staging, dataDir })).rejects.toMatchObject({
      code: 'missing_manifest',
    });
  });
});
