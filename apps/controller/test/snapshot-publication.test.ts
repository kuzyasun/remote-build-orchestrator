import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JobLifecycleNotifier,
  bindJobLifecycleNotifier,
  unbindJobLifecycleNotifier,
} from '../src/jobs/lifecycle-notifier.js';
import { handleJobSubmit } from '../src/jobs/submit.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

describe('S-03 snapshot publication', () => {
  let dataDir: string;
  let fixture: Awaited<ReturnType<typeof createGitFixtureRepo>>;
  let db: ReturnType<typeof openDatabase>;
  let notifier: JobLifecycleNotifier;

  beforeEach(async () => {
    dataDir = join(
      process.cwd(),
      'tmp',
      `test-snapshot-publication-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dataDir, { recursive: true });
    fixture = await createGitFixtureRepo({
      committed: [{ path: 'hello.txt', content: 'hello' }],
    });
    db = openDatabase(':memory:');
    migrateToLatest(db);
    notifier = new JobLifecycleNotifier();
    bindJobLifecycleNotifier(db, notifier);
  });

  afterEach(async () => {
    unbindJobLifecycleNotifier(db);
    notifier.close();
    db.close();
    await fixture.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('publishes generation-scoped files before exposing the job', async () => {
    const identity = await ensureControllerIdentity(dataDir);
    const result = await handleJobSubmit(
      {
        clientId: 'publication-client',
        controllerIdentity: identity,
        db,
        dataDir,
        allowedProjectRoots: [fixture.root],
        allowedArtifactDestinations: [],
        allowFullSnapshotFallback: true,
        defaultQueuePolicy: 'wait',
      },
      {
        client_request_id: 'publication-request',
        source: { project_root: fixture.root, cwd: '.' },
        execution: { script: 'true' },
        requirements: { os: ['unmatched-os'] },
      },
    );

    expect(result.state).toBe('queued');
    const jobId = String(result.job_id);
    const snapshot = db
      .prepare('SELECT manifest_path, payload_path FROM snapshots WHERE id = ?')
      .get(String(result.snapshot_id)) as { manifest_path: string; payload_path: string };
    expect(snapshot.manifest_path).toMatch(/\.g1$/);
    expect(snapshot.payload_path).toMatch(/\.g1$/);
    expect(db.prepare('SELECT snapshot_id FROM jobs WHERE id = ?').get(jobId)).toMatchObject({
      snapshot_id: result.snapshot_id,
    });
    expect(
      db
        .prepare('SELECT state FROM job_submissions WHERE client_id = ? AND client_request_id = ?')
        .get('publication-client', 'publication-request'),
    ).toMatchObject({ state: 'captured' });

    const names = await readdir(join(dataDir, 'snapshots', jobId), { recursive: true });
    expect(names.filter((name) => name.includes('.candidate-'))).toEqual([]);
    expect(names).not.toContain('manifest.json');
  });
});
