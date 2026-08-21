import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureAndPersistSnapshot } from '../src/execution/runner.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

describe('captureAndPersistSnapshot publication boundary', () => {
  let dataDir: string;
  let fixture: Awaited<ReturnType<typeof createGitFixtureRepo>>;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    dataDir = join(
      process.cwd(),
      'tmp',
      `test-runner-capture-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dataDir, { recursive: true });
    db = openDatabase(':memory:');
    migrateToLatest(db);
    fixture = await createGitFixtureRepo({
      committed: [{ path: 'hello.txt', content: 'hello' }],
    });
  });

  afterEach(async () => {
    await fixture?.cleanup();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns only a private candidate and does not persist a snapshot row', async () => {
    const captured = await captureAndPersistSnapshot(
      {
        db,
        dataDir,
        allowedProjectRoots: [fixture.root],
        allowedArtifactDestinations: [],
        allowFullSnapshotFallback: true,
      },
      'job_capture_boundary',
      {
        client_request_id: 'request_capture_boundary',
        source: { project_root: fixture.root, cwd: '.' },
        execution: { script: 'true' },
      },
      17,
    );

    expect(captured.archivePath).toContain('.g17.candidate-');
    expect(captured.manifestPath).toContain('.g17.candidate-');
    expect(captured.secretWarningsPath).toContain('.g17.candidate-');
    expect(captured.gitSourceRequirementsPath).toContain('.g17.candidate-');
    await expect(stat(captured.archivePath)).resolves.toBeDefined();
    await expect(stat(captured.manifestPath)).resolves.toBeDefined();
    await expect(stat(captured.secretWarningsPath)).resolves.toBeDefined();
    await expect(stat(captured.gitSourceRequirementsPath)).resolves.toBeDefined();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({
      count: 0,
    });
    await expect(
      stat(join(dataDir, 'snapshots', 'job_capture_boundary', 'manifest.json')),
    ).rejects.toThrow();
    await expect(stat(captured.archivePath.replace(/\.candidate-[^\\/]+$/, ''))).rejects.toThrow();

    await captured.cleanupCandidate();
    await expect(stat(captured.archivePath)).rejects.toThrow();
    await expect(stat(captured.manifestPath)).rejects.toThrow();
    await expect(stat(captured.secretWarningsPath)).rejects.toThrow();
    await expect(stat(captured.gitSourceRequirementsPath)).rejects.toThrow();
    const remaining = await readdir(join(dataDir, 'snapshots', 'job_capture_boundary'), {
      recursive: true,
    });
    expect(remaining.filter((name) => name.includes('.candidate-'))).toEqual([]);
    expect(await stat(dirname(captured.archivePath))).toBeDefined();
  });
});
