import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RboError, ensureControllerIdentity } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCaptureLease,
  releaseCaptureLease,
  reserveCaptureLease,
} from '../src/jobs/capture-lease.js';
import {
  JobLifecycleNotifier,
  bindJobLifecycleNotifier,
  unbindJobLifecycleNotifier,
} from '../src/jobs/lifecycle-notifier.js';
import { getSubmission } from '../src/jobs/submissions.js';
import { type SnapshotPublicationTestHooks, handleJobSubmit } from '../src/jobs/submit.js';
import { recoverSnapshotPublications } from '../src/recovery/snapshot-publication.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

function injectedFailure(): never {
  throw new RboError('lease_expired', 'Injected snapshot publication interruption', true);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('S-03 snapshot publication failure boundaries', () => {
  let dataDir: string;
  let fixture: Awaited<ReturnType<typeof createGitFixtureRepo>>;
  let db: ReturnType<typeof openDatabase>;
  let identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;

  beforeEach(async () => {
    dataDir = join(
      process.cwd(),
      'tmp',
      `test-snapshot-publication-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fixture = await createGitFixtureRepo({
      committed: [{ path: 'hello.txt', content: 'hello' }],
    });
    db = openDatabase(':memory:');
    migrateToLatest(db);
    identity = await ensureControllerIdentity(dataDir);
  });

  afterEach(async () => {
    db.close();
    await fixture.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function submit(
    clientRequestId: string,
    snapshotPublicationTestHooks?: SnapshotPublicationTestHooks,
  ): Promise<Record<string, unknown>> {
    return handleJobSubmit(
      {
        clientId: 'publication-failure-client',
        controllerIdentity: identity,
        db,
        dataDir,
        allowedProjectRoots: [fixture.root],
        allowedArtifactDestinations: [],
        allowFullSnapshotFallback: true,
        defaultQueuePolicy: 'wait',
        snapshotPublicationTestHooks,
      },
      {
        client_request_id: clientRequestId,
        source: { project_root: fixture.root, cwd: '.' },
        execution: { script: 'true' },
        requirements: { os: ['unmatched-os'] },
      },
    );
  }

  async function snapshotNames(): Promise<string[]> {
    return readdir(join(dataDir, 'snapshots'), { recursive: true }).then((entries) =>
      entries.map(String),
    );
  }

  async function expectNoDatabaseExposure(clientRequestId: string): Promise<void> {
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 0 });
    expect(getSubmission(db, 'publication-failure-client', clientRequestId)?.state).toBe(
      'capturing',
    );
    expect((await snapshotNames()).filter((name) => name.includes('.candidate-'))).toEqual([]);
  }

  it.each([
    ['after capture guard and manifest serialization', { afterCapture: injectedFailure }],
    [
      'after a candidate flush',
      {
        afterCandidateFlush: (_path: string, index: number) =>
          index === 0 ? injectedFailure() : undefined,
      },
    ],
    [
      'immediately before the first no-replace publication',
      {
        beforeCandidatePublication: (_path: string, index: number) =>
          index === 0 && injectedFailure(),
      },
    ],
  ] satisfies Array<[string, SnapshotPublicationTestHooks]>)(
    'cleans only private candidates when interrupted %s',
    async (_boundary, hooks) => {
      const clientRequestId = `private-${Math.random().toString(36).slice(2)}`;
      await expect(submit(clientRequestId, hooks)).resolves.toMatchObject({
        error: { category: 'lease_expired' },
      });

      await expectNoDatabaseExposure(clientRequestId);
      expect((await snapshotNames()).filter((name) => /\.g1$/.test(name))).toEqual([]);
    },
  );

  it.each([
    [
      'between archive and manifest publication',
      {
        afterCandidatePublication: (_path: string, index: number) =>
          index === 0 && injectedFailure(),
      },
      1,
    ],
    ['after the parent-directory flush', { afterPublicationDirectoryFlush: injectedFailure }, 4],
    [
      'when its transaction-local conditional authority check rejects',
      {
        beforeTransactionAuthorityCheck: () => {
          db.prepare('DELETE FROM snapshot_capture_leases').run();
        },
      },
      4,
    ],
  ] satisfies Array<[string, SnapshotPublicationTestHooks, number]>)(
    'leaves final files recovery-owned at %s',
    async (_boundary, hooks, finals) => {
      const clientRequestId = `published-${Math.random().toString(36).slice(2)}`;
      await expect(submit(clientRequestId, hooks)).resolves.toMatchObject({
        error: { category: 'lease_expired' },
      });

      await expectNoDatabaseExposure(clientRequestId);
      expect((await snapshotNames()).filter((name) => /\.g1$/.test(name))).toHaveLength(finals);
    },
  );

  it('reclaims the same key into a new generation and recovers only the prior final orphan', async () => {
    const clientRequestId = 'retry-after-published-orphan';
    await expect(
      submit(clientRequestId, {
        afterCandidatePublication: (_path, index) => index === 0 && injectedFailure(),
      }),
    ).resolves.toMatchObject({ error: { category: 'lease_expired' } });
    await expectNoDatabaseExposure(clientRequestId);

    const orphanNames = await snapshotNames();
    expect(orphanNames.filter((name) => /\.g1$/.test(name))).toHaveLength(1);

    const retry = await submit(clientRequestId);
    expect(retry).toMatchObject({ state: 'queued', snapshot_captured: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 1 });
    expect((await snapshotNames()).filter((name) => /\.g1$/.test(name))).toHaveLength(1);

    const snapshot = db.prepare('SELECT manifest_path, payload_path FROM snapshots').get() as {
      manifest_path: string;
      payload_path: string;
    };
    expect(snapshot.manifest_path).toMatch(/\.g2$/);
    expect(snapshot.payload_path).toMatch(/\.g2$/);
    await expect(exists(snapshot.manifest_path)).resolves.toBe(true);
    await expect(exists(snapshot.payload_path)).resolves.toBe(true);

    await expect(
      recoverSnapshotPublications({ db, dataDir, now: new Date(Date.now() + 1_000) }),
    ).resolves.toMatchObject({ skippedForActiveLease: false });
    const recoveredNames = await snapshotNames();
    expect(recoveredNames.filter((name) => /\.candidate-/.test(name))).toEqual([]);
    expect(recoveredNames.filter((name) => /\.g1$/.test(name))).toEqual([]);
    expect(recoveredNames.filter((name) => /\.g2$/.test(name))).toHaveLength(4);
    await expect(exists(snapshot.manifest_path)).resolves.toBe(true);
    await expect(exists(snapshot.payload_path)).resolves.toBe(true);
  });

  it('retries the same key after a generic transaction interruption', async () => {
    const clientRequestId = 'retry-after-generic-transaction-interruption';
    await expect(
      submit(clientRequestId, {
        afterSnapshotPersisted: () => {
          throw new Error('transient SQLite interruption');
        },
      }),
    ).resolves.toMatchObject({
      error: { category: 'internal', retryable: true },
    });

    await expectNoDatabaseExposure(clientRequestId);
    expect((await snapshotNames()).filter((name) => /\.g1$/.test(name))).toHaveLength(4);

    const retry = await submit(clientRequestId);
    expect(retry).toMatchObject({ state: 'queued', snapshot_captured: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 1 });

    const snapshot = db.prepare('SELECT manifest_path, payload_path FROM snapshots').get() as {
      manifest_path: string;
      payload_path: string;
    };
    expect(snapshot.manifest_path).toMatch(/\.g2$/);
    expect(snapshot.payload_path).toMatch(/\.g2$/);
    expect((await snapshotNames()).filter((name) => name.includes('.candidate-'))).toEqual([]);

    await recoverSnapshotPublications({ db, dataDir, now: new Date(Date.now() + 1_000) });
    const recoveredNames = await snapshotNames();
    expect(recoveredNames.filter((name) => /\.g1$/.test(name))).toEqual([]);
    expect(recoveredNames.filter((name) => /\.g2$/.test(name))).toHaveLength(4);
  });

  it('retries the same key after a generic interruption between publications', async () => {
    const clientRequestId = 'retry-after-generic-publication-interruption';
    await expect(
      submit(clientRequestId, {
        afterCandidatePublication: (_path, index) => {
          if (index === 0) throw new Error('transient filesystem interruption');
        },
      }),
    ).resolves.toMatchObject({
      error: { category: 'internal', retryable: true },
    });

    await expectNoDatabaseExposure(clientRequestId);
    expect((await snapshotNames()).filter((name) => /\.g1$/.test(name))).toHaveLength(1);

    const retry = await submit(clientRequestId);
    expect(retry).toMatchObject({ state: 'queued', snapshot_captured: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 1 });
    expect((await snapshotNames()).filter((name) => name.includes('.candidate-'))).toEqual([]);

    const snapshot = db.prepare('SELECT manifest_path, payload_path FROM snapshots').get() as {
      manifest_path: string;
      payload_path: string;
    };
    expect(snapshot.manifest_path).toMatch(/\.g2$/);
    expect(snapshot.payload_path).toMatch(/\.g2$/);

    await recoverSnapshotPublications({ db, dataDir, now: new Date(Date.now() + 1_000) });
    const recoveredNames = await snapshotNames();
    expect(recoveredNames.filter((name) => /\.g1$/.test(name))).toEqual([]);
    expect(recoveredNames.filter((name) => /\.g2$/.test(name))).toHaveLength(4);
  });

  it('terminalizes an explicitly non-retryable capture failure', async () => {
    const clientRequestId = 'non-retryable-capture-failure';
    let reentrantReservation: ReturnType<typeof reserveCaptureLease> | undefined;
    const first = await submit(clientRequestId, {
      afterCapture: () => {
        throw RboError.validation('Injected non-retryable capture failure');
      },
      beforeConditionalTerminalSubmissionFailure: () => {
        reentrantReservation = reserveCaptureLease(db, {
          clientId: 'publication-failure-client',
          clientRequestId,
        });
      },
    });

    expect(first).toMatchObject({ error: { category: 'validation', retryable: false } });
    expect(reentrantReservation).toMatchObject({
      acquired: false,
      reason: 'active',
      lease: { fencingGeneration: 1 },
      submission: { state: 'capturing' },
    });
    expect(getSubmission(db, 'publication-failure-client', clientRequestId)).toMatchObject({
      state: 'failed',
    });
    expect((await snapshotNames()).filter((name) => name.includes('.candidate-'))).toEqual([]);

    await expect(submit(clientRequestId)).resolves.toEqual(first);
    expect(
      reserveCaptureLease(db, {
        clientId: 'publication-failure-client',
        clientRequestId,
      }),
    ).toMatchObject({ acquired: false, reason: 'terminal', submission: { state: 'failed' } });
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 0 });
  });

  it('does not terminalize after the old owner loses authority before conditional failure persistence', async () => {
    const clientRequestId = 'lost-authority-before-terminal-failure';
    let reclaimedReservation: ReturnType<typeof reserveCaptureLease> | undefined;
    const result = await submit(clientRequestId, {
      afterCapture: () => {
        throw RboError.validation('Injected non-retryable capture failure');
      },
      beforeConditionalTerminalSubmissionFailure: () => {
        const oldLease = getCaptureLease(db, {
          clientId: 'publication-failure-client',
          clientRequestId,
        });
        expect(oldLease).not.toBeNull();
        if (!oldLease) throw new Error('Expected old capture lease');
        releaseCaptureLease(db, oldLease);
        reclaimedReservation = reserveCaptureLease(db, {
          clientId: 'publication-failure-client',
          clientRequestId,
        });
      },
    });

    expect(result).toMatchObject({ error: { category: 'lease_expired', retryable: true } });
    expect(reclaimedReservation).toMatchObject({
      acquired: true,
      lease: { fencingGeneration: 2 },
      submission: { state: 'capturing' },
    });
    expect(getSubmission(db, 'publication-failure-client', clientRequestId)).toMatchObject({
      state: 'capturing',
      error_json: null,
    });
    expect(
      getCaptureLease(db, {
        clientId: 'publication-failure-client',
        clientRequestId,
      }),
    ).toMatchObject({
      ownerToken: reclaimedReservation?.lease?.ownerToken,
      fencingGeneration: 2,
    });
  });

  it('rolls back post-persist publication failure without a submission response or notifier wakeup', async () => {
    const clientRequestId = 'rollback-after-snapshot-persist';
    const notifier = new JobLifecycleNotifier();
    bindJobLifecycleNotifier(db, notifier);
    const notifyAfterCommit = vi.spyOn(notifier, 'notifyAfterCommit');
    const notify = vi.spyOn(notifier, 'notify');

    try {
      await expect(
        submit(clientRequestId, { afterSnapshotPersisted: injectedFailure }),
      ).resolves.toMatchObject({ error: { category: 'lease_expired' } });

      expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({
        count: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 0 });
      expect(getSubmission(db, 'publication-failure-client', clientRequestId)).toMatchObject({
        state: 'capturing',
        job_id: null,
        response_json: null,
        error_json: null,
      });
      expect(notifyAfterCommit).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();

      const publishedNames = await snapshotNames();
      expect(publishedNames.filter((name) => /\.g1$/.test(name))).toHaveLength(4);
      expect(publishedNames.filter((name) => name.includes('.candidate-'))).toEqual([]);

      const retry = await submit(clientRequestId);
      expect(retry).toMatchObject({ state: 'queued', snapshot_captured: true });
      expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({
        count: 1,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toMatchObject({ count: 1 });
      expect(getSubmission(db, 'publication-failure-client', clientRequestId)).toMatchObject({
        state: 'captured',
      });

      const snapshot = db.prepare('SELECT manifest_path, payload_path FROM snapshots').get() as {
        manifest_path: string;
        payload_path: string;
      };
      expect(snapshot.manifest_path).toMatch(/\.g2$/);
      expect(snapshot.payload_path).toMatch(/\.g2$/);
      await expect(exists(snapshot.manifest_path)).resolves.toBe(true);
      await expect(exists(snapshot.payload_path)).resolves.toBe(true);

      expect((await snapshotNames()).filter((name) => /\.g1$/.test(name))).toHaveLength(4);
      expect((await snapshotNames()).filter((name) => /\.g2$/.test(name))).toHaveLength(4);
      await expect(
        recoverSnapshotPublications({ db, dataDir, now: new Date(Date.now() + 1_000) }),
      ).resolves.toMatchObject({ skippedForActiveLease: false });

      const recoveredNames = await snapshotNames();
      expect(recoveredNames.filter((name) => /\.g1$/.test(name))).toEqual([]);
      expect(recoveredNames.filter((name) => /\.g2$/.test(name))).toHaveLength(4);
      await expect(exists(snapshot.manifest_path)).resolves.toBe(true);
      await expect(exists(snapshot.payload_path)).resolves.toBe(true);
    } finally {
      notifyAfterCommit.mockRestore();
      notify.mockRestore();
      unbindJobLifecycleNotifier(db);
      notifier.close();
    }
  });
});
