import { afterEach, describe, expect, it } from 'vitest';
import {
  JobLifecycleNotifier,
  bindJobLifecycleNotifier,
  unbindJobLifecycleNotifier,
} from '../src/jobs/lifecycle-notifier.js';
import { createJob, getJob, transitionJobState } from '../src/jobs/lifecycle.js';
import { waitForJob } from '../src/jobs/submit.js';
import { type ControllerDatabase, migrateToLatest, openDatabase } from '../src/storage/database.js';

function makeContext(db: ControllerDatabase) {
  return {
    db,
    dataDir: '',
    allowedProjectRoots: [],
    allowedArtifactDestinations: [],
  } as Parameters<typeof waitForJob>[0];
}

describe('waitForJob event-driven lifecycle', () => {
  let db: ControllerDatabase | undefined;
  let notifier: JobLifecycleNotifier | undefined;

  afterEach(() => {
    if (db?.open) {
      if (notifier) unbindJobLifecycleNotifier(db);
      notifier?.close();
      db.close();
    }
    db = undefined;
    notifier = undefined;
  });

  function setup() {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    notifier = new JobLifecycleNotifier();
    bindJobLifecycleNotifier(db, notifier);
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: `request-${Date.now()}`,
      request: { command: 'echo ok', project_root: '.', risk_level: 'safe' },
      initialState: 'running',
    });
    return { db, notifier, job };
  }

  it('returns a job that became terminal before waiting starts', async () => {
    const { db, job } = setup();
    transitionJobState(db, job.id, 'completed', { outcome: 'succeeded' });

    const result = await waitForJob(makeContext(db), job.id, 1);

    expect((result.job as { state: string }).state).toBe('completed');
    expect(notifier?.listenerCount()).toBe(0);
  });

  it('closes the initial-read to subscribe race without waiting for the fallback', async () => {
    const { db, job, notifier } = setup();
    const result = await waitForJob(makeContext(db), job.id, 2, {
      testHooks: {
        beforeSubscribe: () => {
          transitionJobState(db, job.id, 'completed', { outcome: 'succeeded' });
        },
      },
    });

    expect((result.job as { state: string }).state).toBe('completed');
    expect(notifier.listenerCount()).toBe(0);
  });

  it('closes the subscribe to reread race without waiting for the fallback', async () => {
    const { db, job, notifier } = setup();
    const result = await waitForJob(makeContext(db), job.id, 2, {
      testHooks: {
        afterSubscribe: () => {
          transitionJobState(db, job.id, 'completed', { outcome: 'succeeded' });
        },
      },
    });

    expect((result.job as { state: string }).state).toBe('completed');
    expect(notifier.listenerCount()).toBe(0);
  });

  it('wakes all waiters on one committed transition without polling delay', async () => {
    const { db, job, notifier } = setup();
    const context = makeContext(db);
    const first = waitForJob(context, job.id, 2);
    const second = waitForJob(context, job.id, 2);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notifier.listenerCount(job.id)).toBe(2);
    transitionJobState(db, job.id, 'completed', { outcome: 'succeeded' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect((firstResult.job as { state: string }).state).toBe('completed');
    expect((secondResult.job as { state: string }).state).toBe('completed');
    expect(notifier.listenerCount()).toBe(0);
  });

  it('removes its listener when aborted', async () => {
    const { db, job, notifier } = setup();
    const controller = new AbortController();
    const startedAt = Date.now();
    const waiting = waitForJob(makeContext(db), job.id, 2, { signal: controller.signal });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notifier.listenerCount(job.id)).toBe(1);
    controller.abort();

    const result = await waiting;
    expect((result.job as { state: string }).state).toBe('running');
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(notifier.listenerCount()).toBe(0);
  });

  it.each([
    { label: 'cancelled', outcome: 'cancelled' },
    { label: 'lost during recovery', outcome: 'failed' },
  ])('wakes and cleans up for a $label terminal outcome', async ({ outcome }) => {
    const { db, job, notifier } = setup();
    const waiting = waitForJob(makeContext(db), job.id, 2);

    expect(notifier.listenerCount(job.id)).toBe(1);
    transitionJobState(db, job.id, 'completed', { outcome });

    const result = await waiting;
    expect((result.job as { state: string; outcome: string }).state).toBe('completed');
    expect((result.job as { state: string; outcome: string }).outcome).toBe(outcome);
    expect(notifier.listenerCount()).toBe(0);
  });

  it('rereads durable state when a lifecycle notification is missed', async () => {
    const { db, job, notifier } = setup();
    const waiting = waitForJob(makeContext(db), job.id, 2);

    await new Promise<void>((resolve) => setImmediate(resolve));
    // Simulate a legacy/raw writer that does not publish an in-process wakeup.
    db.prepare("UPDATE jobs SET state = 'completed', outcome = 'succeeded' WHERE id = ?").run(
      job.id,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
    const result = await waiting;
    expect((result.job as { state: string }).state).toBe('completed');
    expect(notifier.listenerCount()).toBe(0);
  });

  it('does not retain listeners after timeout', async () => {
    const { db, job, notifier } = setup();
    const result = await waitForJob(makeContext(db), job.id, 0.01);

    expect((result.job as { state: string }).state).toBe('running');
    expect(getJob(db, job.id)?.state).toBe('running');
    expect(notifier.listenerCount()).toBe(0);
  });
});
