import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readAttemptMetadata,
  writeAttemptMetadata,
} from '../../agent/src/recovery/attempt-metadata.js';
import {
  applyDiskPressureCleanup,
  isAcceptingJobsUnderDiskPressure,
} from '../../agent/src/recovery/disk-pressure.js';
import {
  clearArtifactExpectations,
  filterMissingArtifacts,
  registerArtifactExpectations,
} from '../src/http/data-plane.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';

describe('Disk-pressure admission + cleanup order (§31.4)', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function seedTree(): Promise<{
    activeId: string;
    expiredArtifact: string;
    oldWorkspace: string;
    oldSpool: string;
    inactiveRepo: string;
    activeRepo: string;
  }> {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-disk-pressure-'));
    const activeId = 'att_active';
    const terminalOld = 'att_old';
    const expiredArtifact = join(stateDir, 'artifacts', terminalOld, 'out.bin');
    const oldWorkspace = join(stateDir, 'workspaces', terminalOld, 'marker.txt');
    const oldSpool = join(stateDir, 'logs', terminalOld, 'marker.txt');
    const inactiveRepo = join(stateDir, 'repos', 'repo_inactive', 'marker.txt');
    const activeRepo = join(stateDir, 'repos', 'repo_active', 'marker.txt');
    const activeWorkspace = join(stateDir, 'workspaces', activeId, 'marker.txt');
    const activeSpool = join(stateDir, 'logs', activeId, 'marker.txt');
    const activeArtifact = join(stateDir, 'artifacts', activeId, 'live.bin');

    for (const path of [
      expiredArtifact,
      oldWorkspace,
      oldSpool,
      inactiveRepo,
      activeRepo,
      activeWorkspace,
      activeSpool,
      activeArtifact,
    ]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'keep-or-delete');
    }

    await writeFile(
      join(stateDir, 'repos', 'repo_inactive', 'metadata.json'),
      JSON.stringify({
        canonical_id: 'inactive',
        last_used_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        active_worktree_count: 0,
      }),
    );
    await writeFile(
      join(stateDir, 'repos', 'repo_active', 'metadata.json'),
      JSON.stringify({
        canonical_id: 'active',
        last_used_at: new Date().toISOString(),
        active_worktree_count: 1,
      }),
    );

    await mkdir(join(stateDir, 'attempts', terminalOld), { recursive: true });
    await writeFile(
      join(stateDir, 'attempts', terminalOld, 'metadata.json'),
      JSON.stringify({
        attempt_id: terminalOld,
        job_id: 'job_old',
        lease_id: 'l',
        lease_epoch: 1,
        process_identity: 'pid:1',
        status: 'terminal',
        workspace_path: join(stateDir, 'workspaces', terminalOld),
        spool_dir: join(stateDir, 'logs', terminalOld),
        risk_level: 'normal',
        updated_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    await mkdir(join(stateDir, 'attempts', activeId), { recursive: true });
    await writeFile(
      join(stateDir, 'attempts', activeId, 'metadata.json'),
      JSON.stringify({
        attempt_id: activeId,
        job_id: 'job_live',
        lease_id: 'l2',
        lease_epoch: 1,
        process_identity: 'pid:2',
        status: 'running',
        workspace_path: join(stateDir, 'workspaces', activeId),
        spool_dir: join(stateDir, 'logs', activeId),
        risk_level: 'normal',
        updated_at: new Date().toISOString(),
      }),
    );

    return { activeId, expiredArtifact, oldWorkspace, oldSpool, inactiveRepo, activeRepo };
  }

  it('refuses new leases when free disk is below threshold', () => {
    expect(
      isAcceptingJobsUnderDiskPressure({
        freeBytes: 100,
        minFreeBytes: 1_000,
        spoolPressure: false,
      }),
    ).toBe(false);
    expect(
      isAcceptingJobsUnderDiskPressure({
        freeBytes: 5_000,
        minFreeBytes: 1_000,
        spoolPressure: false,
      }),
    ).toBe(true);
    expect(
      isAcceptingJobsUnderDiskPressure({
        freeBytes: 5_000,
        minFreeBytes: 1_000,
        spoolPressure: true,
      }),
    ).toBe(false);
  });

  it('cleans expired artifacts → old workspaces → old spools → inactive repos; never active', async () => {
    const seeded = await seedTree();
    const deletedOrder: string[] = [];

    const result = await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 10_000,
      freeBytes: 100,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      nowMs: Date.now(),
      onDelete: (kind, path) => {
        deletedOrder.push(`${kind}:${path}`);
      },
    });

    expect(result.acceptingJobs).toBe(false);
    expect(result.deletedKinds).toEqual(['artifacts', 'workspaces', 'spools', 'repos']);

    const kinds = deletedOrder.map((e) => e.split(':')[0]);
    const firstArt = kinds.indexOf('artifacts');
    const firstWs = kinds.indexOf('workspaces');
    const firstSpool = kinds.indexOf('spools');
    const firstRepo = kinds.indexOf('repos');
    expect(firstArt).toBeGreaterThanOrEqual(0);
    expect(firstWs).toBeGreaterThan(firstArt);
    expect(firstSpool).toBeGreaterThan(firstWs);
    expect(firstRepo).toBeGreaterThan(firstSpool);

    const { readFile } = await import('node:fs/promises');
    await expect(readFile(seeded.expiredArtifact, 'utf8')).rejects.toThrow();
    await expect(readFile(seeded.oldWorkspace, 'utf8')).rejects.toThrow();
    await expect(readFile(seeded.oldSpool, 'utf8')).rejects.toThrow();
    await expect(readFile(seeded.inactiveRepo, 'utf8')).rejects.toThrow();

    await expect(
      readFile(join(stateDir, 'workspaces', seeded.activeId, 'marker.txt'), 'utf8'),
    ).resolves.toBe('keep-or-delete');
    await expect(
      readFile(join(stateDir, 'logs', seeded.activeId, 'marker.txt'), 'utf8'),
    ).resolves.toBe('keep-or-delete');
    await expect(
      readFile(join(stateDir, 'artifacts', seeded.activeId, 'live.bin'), 'utf8'),
    ).resolves.toBe('keep-or-delete');
    await expect(readFile(seeded.activeRepo, 'utf8')).resolves.toBe('keep-or-delete');
  });

  it('spool pressure alone triggers cleanup even when free disk is ample', async () => {
    const seeded = await seedTree();
    const deletedOrder: string[] = [];
    const result = await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 1,
      freeBytes: 10 * 1024 ** 3,
      spoolPressure: true,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      onDelete: (kind, path) => {
        deletedOrder.push(`${kind}:${path}`);
      },
      evictInactiveRepos: async () => {
        deletedOrder.push(`repos:${join(stateDir, 'repos', 'repo_inactive')}`);
        return [join(stateDir, 'repos', 'repo_inactive')];
      },
    });
    expect(result.acceptingJobs).toBe(false);
    expect(deletedOrder.some((e) => e.startsWith('artifacts:'))).toBe(true);
    const { readFile } = await import('node:fs/promises');
    await expect(
      readFile(join(stateDir, 'workspaces', seeded.activeId, 'marker.txt'), 'utf8'),
    ).resolves.toBe('keep-or-delete');
  });

  it('artifact resume grants only missing hash-verified objects', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-artifact-missing-'));
    const attemptId = 'att_resume';
    const present = Buffer.from('already-there');
    const missing = Buffer.from('need-upload');
    const presentHash = createHash('sha256').update(present).digest('hex');
    const missingHash = createHash('sha256').update(missing).digest('hex');
    // Controller stores under attempts/<id>/artifacts/
    const artDir = join(stateDir, 'attempts', attemptId, 'artifacts');
    await mkdir(artDir, { recursive: true });
    await writeFile(join(artDir, 'present.bin'), present);

    const manifest = [
      { logical_name: 'present.bin', size_bytes: present.length, sha256: presentHash },
      { logical_name: 'missing.bin', size_bytes: missing.length, sha256: missingHash },
    ];
    const db = openDatabase(':memory:');
    try {
      migrateToLatest(db);
      db.prepare(
        "INSERT INTO jobs (id, client_id, client_request_id, state, created_at, updated_at, request_json) VALUES ('job_resume', 'client', 'request', 'collecting_artifacts', ?, ?, '{}')",
      ).run(nowIso(), nowIso());
      db.prepare(
        "INSERT INTO job_attempts (id, job_id, ordinal, lease_id, lease_epoch, state) VALUES (?, 'job_resume', 1, 'lease', 1, 'collecting_artifacts')",
      ).run(attemptId);
      db.prepare(
        `INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at)
         VALUES ('art_legacy', 'job_resume', ?, 'present.bin', ?, ?, ?, ?)`,
      ).run(attemptId, join(artDir, 'present.bin'), present.length, presentHash, nowIso());
      registerArtifactExpectations(attemptId, manifest);
      const filtered = await filterMissingArtifacts(
        { db, dataDir: stateDir },
        attemptId,
        manifest,
        () => true,
      );

      expect(filtered.map((a) => a.logical_name)).toEqual(['missing.bin']);
      expect(
        db
          .prepare('SELECT path, size_bytes, sha256 FROM artifacts WHERE attempt_id = ?')
          .all(attemptId),
      ).toEqual([
        { path: join(artDir, 'present.bin'), size_bytes: present.length, sha256: presentHash },
      ]);
    } finally {
      clearArtifactExpectations(attemptId);
      db.close();
    }
  });

  it('retires leftover artifact staging while keeping metadata for a pending cleanup replay', async () => {
    const { activeId } = await seedTree();
    const meta = readAttemptMetadata(stateDir, activeId);
    if (!meta) throw new Error('Missing fixture attempt metadata');
    writeAttemptMetadata(stateDir, {
      ...meta,
      status: 'completed_awaiting_upload',
      artifact_transfer: 'failed',
    });
    const cleaned: string[] = [];
    await applyDiskPressureCleanup({
      stateDir,
      freeBytes: 0,
      minFreeBytes: 1,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      cleanupAttemptResources: async (attemptId) => {
        cleaned.push(attemptId);
      },
      evictInactiveRepos: async () => [],
    });
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(join(stateDir, 'artifacts', activeId, 'live.bin'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    await expect(
      readFile(join(stateDir, 'workspaces', activeId, 'marker.txt'), 'utf8'),
    ).resolves.toBe('keep-or-delete');
    expect(readAttemptMetadata(stateDir, activeId)).toMatchObject({
      status: 'completed_awaiting_upload',
      artifact_transfer: 'failed',
    });
    expect(cleaned).not.toContain(activeId);
  });
});
