import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity, writeMinimalBackupFixture } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('rbo controller restore (§26, runbook)', () => {
  it('restores a valid backup onto a fresh data dir with no prior identity', async () => {
    const staging = await tempDir('rbo-cli-restore-ok-');
    const dataDir = await tempDir('rbo-cli-restore-target-');
    await writeMinimalBackupFixture(staging, 3, 'ctrl_fixture_1');

    const result = await runControllerRestore({ stagingDir: staging, dataDir });
    expect(result.ok).toBe(true);
    expect(result.controller_id).toBe('ctrl_fixture_1');
    expect(result.files_restored).toBeGreaterThan(0);

    const restoredDb = await readFile(join(dataDir, 'controller.sqlite'), 'utf8');
    expect(restoredDb).toBe('sqlite-fixture');
    const restoredId = await readFile(join(dataDir, 'identity', 'controller-id.txt'), 'utf8');
    expect(restoredId).toBe('ctrl_fixture_1');
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

  it("accepts restoring the same controller's own backup back onto its data dir", async () => {
    const staging = await tempDir('rbo-cli-restore-same-');
    const dataDir = await tempDir('rbo-cli-restore-self-');
    const identity = await ensureControllerIdentity(dataDir);
    await writeMinimalBackupFixture(staging, 3, identity.controllerId);

    const result = await runControllerRestore({ stagingDir: staging, dataDir });
    expect(result.controller_id).toBe(identity.controllerId);
  });

  it('rejects a staging dir with no BACKUP_MANIFEST.json', async () => {
    const staging = await tempDir('rbo-cli-restore-nomanifest-');
    const dataDir = await tempDir('rbo-cli-restore-nomanifest-target-');
    await mkdir(join(staging, 'identity'), { recursive: true });
    await writeFile(join(staging, 'controller.sqlite'), 'x');

    await expect(runControllerRestore({ stagingDir: staging, dataDir })).rejects.toMatchObject({
      code: 'missing_manifest',
    });
  });
});
