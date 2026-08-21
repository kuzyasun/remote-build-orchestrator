import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureLeaseMockState = vi.hoisted(() => ({
  mode: 'before' as 'before' | 'after' | 'never',
  authorityChecks: 0,
}));

vi.mock('../src/jobs/capture-lease.js', async () => {
  const actual = await vi.importActual<typeof import('../src/jobs/capture-lease.js')>(
    '../src/jobs/capture-lease.js',
  );
  return {
    ...actual,
    hasCaptureLeaseAuthority: (...args: Parameters<typeof actual.hasCaptureLeaseAuthority>) => {
      captureLeaseMockState.authorityChecks += 1;
      if (
        (captureLeaseMockState.mode === 'before' && captureLeaseMockState.authorityChecks === 1) ||
        (captureLeaseMockState.mode === 'after' && captureLeaseMockState.authorityChecks === 2)
      ) {
        return false;
      }
      return actual.hasCaptureLeaseAuthority(...args);
    },
  };
});

vi.mock('../src/execution/runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/execution/runner.js')>(
    '../src/execution/runner.js',
  );
  const captureAndPersistSnapshot = async (
    ctx: Parameters<typeof actual.captureAndPersistSnapshot>[0],
    jobId: string,
    request: Parameters<typeof actual.captureAndPersistSnapshot>[2],
    fencingGeneration: Parameters<typeof actual.captureAndPersistSnapshot>[3],
  ): Promise<Awaited<ReturnType<typeof actual.captureAndPersistSnapshot>>> => {
    const root = join(ctx.dataDir, 'snapshots', jobId);
    await mkdir(root, { recursive: true });
    const suffix = `.g${fencingGeneration}.candidate-stale`;
    const archivePath = join(root, `archive.tar.zst${suffix}`);
    const manifestPath = join(root, `manifest.json${suffix}`);
    const secretWarningsPath = join(root, `secret-warnings.json${suffix}`);
    const gitSourceRequirementsPath = join(root, `git-source-requirements.json${suffix}`);
    await Promise.all(
      [archivePath, manifestPath, secretWarningsPath, gitSourceRequirementsPath].map((path) =>
        writeFile(path, '{}'),
      ),
    );
    return {
      snapshotId: 'snapshot-stale',
      contentId: 'content-stale',
      secretWarnings: [],
      gitSourceRequirements: { submodules: false, lfs: false },
      request,
      manifestPath,
      archivePath,
      sizeBytes: 2,
      sha256: 'a'.repeat(64),
      repoId: 'local',
      baseCommit: null,
      cleanupCandidate: async () => {
        await Promise.all(
          [archivePath, manifestPath, secretWarningsPath, gitSourceRequirementsPath].map((path) =>
            rm(path, { force: true }),
          ),
        );
      },
      secretWarningsPath,
      gitSourceRequirementsPath,
    };
  };
  return { ...actual, captureAndPersistSnapshot };
});

import { getSubmission } from '../src/jobs/submissions.js';
import { handleJobSubmit } from '../src/jobs/submit.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

describe('S-03 stale capture authority', () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  let identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;

  beforeEach(async () => {
    captureLeaseMockState.mode = 'before';
    captureLeaseMockState.authorityChecks = 0;
    dataDir = join(
      process.cwd(),
      'tmp',
      `test-snapshot-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dataDir, { recursive: true });
    db = openDatabase(':memory:');
    migrateToLatest(db);
    identity = await ensureControllerIdentity(dataDir);
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects a reclaimed owner before publication and cleans private candidates', async () => {
    const result = await handleJobSubmit(
      {
        clientId: 'stale-client',
        controllerIdentity: identity,
        db,
        dataDir,
        allowedProjectRoots: [],
        allowedArtifactDestinations: [],
      },
      {
        client_request_id: 'stale-request',
        source: { project_root: '.', cwd: '.' },
        execution: { script: 'true' },
      },
    );

    expect(result.error).toMatchObject({ category: 'lease_expired' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 0 });
    expect(getSubmission(db, 'stale-client', 'stale-request')?.state).toBe('capturing');
    const remaining = await readdir(join(dataDir, 'snapshots'), { recursive: true });
    expect(remaining.filter((name) => name.includes('.candidate-'))).toEqual([]);
  });

  it('retains published generation files when authority fails after publication', async () => {
    captureLeaseMockState.mode = 'after';
    const result = await handleJobSubmit(
      {
        clientId: 'stale-client-after-publication',
        controllerIdentity: identity,
        db,
        dataDir,
        allowedProjectRoots: [],
        allowedArtifactDestinations: [],
      },
      {
        client_request_id: 'stale-request-after-publication',
        source: { project_root: '.', cwd: '.' },
        execution: { script: 'true' },
      },
    );

    expect(result.error).toMatchObject({ category: 'lease_expired' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 0 });
    const remaining = await readdir(join(dataDir, 'snapshots'), { recursive: true });
    expect(remaining.some((name) => String(name).endsWith('archive.tar.zst.g1'))).toBe(true);
    expect(remaining.filter((name) => name.includes('.candidate-'))).toEqual([]);
  });
});
