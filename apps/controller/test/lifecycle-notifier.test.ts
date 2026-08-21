import { afterEach, describe, expect, it } from 'vitest';
import {
  JobLifecycleNotifier,
  bindJobLifecycleNotifier,
  runJobLifecycleTransaction,
  subscribeToJobLifecycle,
  unbindJobLifecycleNotifier,
} from '../src/jobs/lifecycle-notifier.js';
import { createJob, runLifecycleTransaction, transitionJobState } from '../src/jobs/lifecycle.js';
import { type ControllerDatabase, migrateToLatest, openDatabase } from '../src/storage/database.js';

describe('JobLifecycleNotifier', () => {
  let db: ControllerDatabase | undefined;

  afterEach(() => {
    if (db?.open) db.close();
  });

  it('wakes multiple subscribers and releases completed job listeners', () => {
    const notifier = new JobLifecycleNotifier();
    let first = 0;
    let second = 0;
    notifier.subscribe('job-1', () => {
      first += 1;
    });
    notifier.subscribe('job-1', () => {
      second += 1;
    });

    expect(notifier.listenerCount('job-1')).toBe(2);
    notifier.notify('job-1');

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(notifier.listenerCount('job-1')).toBe(0);
    expect(notifier.listenerCount()).toBe(0);
  });

  it('removes an individual listener without affecting other subscribers', () => {
    const notifier = new JobLifecycleNotifier();
    let removed = 0;
    let retained = 0;
    const unsubscribe = notifier.subscribe('job-2', () => {
      removed += 1;
    });
    notifier.subscribe('job-2', () => {
      retained += 1;
    });
    unsubscribe();
    unsubscribe();

    notifier.notify('job-2');
    expect(removed).toBe(0);
    expect(retained).toBe(1);
    expect(notifier.listenerCount()).toBe(0);
  });

  it('publishes only after commit and discards notifications on rollback', () => {
    db = openDatabase(':memory:');
    const notifier = new JobLifecycleNotifier();
    let calls = 0;
    notifier.subscribe('job-3', () => {
      calls += 1;
    });

    expect(() =>
      notifier.runTransaction(db as ControllerDatabase, () => {
        notifier.notifyAfterCommit(db as ControllerDatabase, 'job-3');
        expect(calls).toBe(0);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(calls).toBe(0);
    expect(notifier.listenerCount('job-3')).toBe(1);

    bindJobLifecycleNotifier(db, notifier);
    runJobLifecycleTransaction(db, () => {
      notifier.notifyAfterCommit(db as ControllerDatabase, 'job-3');
      expect(calls).toBe(0);
    });
    expect(calls).toBe(1);
    expect(notifier.listenerCount('job-3')).toBe(0);
    unbindJobLifecycleNotifier(db);
  });

  it('notifies successful lifecycle transitions after their statement commits', () => {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const notifier = new JobLifecycleNotifier();
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'request',
      request: { command: 'echo ok', project_root: '.', risk_level: 'safe' },
      initialState: 'created',
    });
    let calls = 0;
    bindJobLifecycleNotifier(db, notifier);
    subscribeToJobLifecycle(db, job.id, () => {
      calls += 1;
    });
    subscribeToJobLifecycle(db, job.id, () => {
      calls += 1;
    });

    transitionJobState(db, job.id, 'queued');
    expect(calls).toBe(2);
    expect(notifier.listenerCount(job.id)).toBe(0);

    unbindJobLifecycleNotifier(db);
  });

  it('does not publish a transition until the outer transaction commits', () => {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const notifier = new JobLifecycleNotifier();
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'request-transaction',
      request: { command: 'echo ok', project_root: '.', risk_level: 'safe' },
      initialState: 'created',
    });
    let calls = 0;
    notifier.subscribe(job.id, () => {
      calls += 1;
    });
    bindJobLifecycleNotifier(db, notifier);

    runJobLifecycleTransaction(db, () => {
      transitionJobState(db as ControllerDatabase, job.id, 'queued');
      expect(calls).toBe(0);
    });
    expect(calls).toBe(1);
    unbindJobLifecycleNotifier(db);
  });

  it('cleans all subscriptions on shutdown', () => {
    const notifier = new JobLifecycleNotifier();
    notifier.subscribe('job-4', () => undefined);
    notifier.subscribe('job-5', () => undefined);
    notifier.close();
    expect(notifier.listenerCount()).toBe(0);
    expect(notifier.subscribe('job-4', () => undefined)).toBeTypeOf('function');
    expect(notifier.listenerCount()).toBe(0);
  });

  it('rejects unsupported nesting before the lifecycle operation mutates state', () => {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const notifier = new JobLifecycleNotifier();
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'request-nested',
      request: { command: 'echo ok', project_root: '.', risk_level: 'safe' },
      initialState: 'created',
    });
    let calls = 0;
    notifier.subscribe(job.id, () => {
      calls += 1;
    });
    bindJobLifecycleNotifier(db, notifier);

    const rawOuter = db.transaction(() => {
      expect(() => transitionJobState(db as ControllerDatabase, job.id, 'queued')).toThrow(
        'must use runJobLifecycleTransaction',
      );
    });
    rawOuter();
    expect(
      (db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state,
    ).toBe('created');

    const outer = db.transaction(() => {
      expect(() =>
        runJobLifecycleTransaction(db as ControllerDatabase, () => {
          transitionJobState(db as ControllerDatabase, job.id, 'queued');
        }),
      ).toThrow('inside an existing SQLite transaction');
    });
    outer();

    expect(calls).toBe(0);
    expect(notifier.listenerCount(job.id)).toBe(1);
    expect(
      (db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state,
    ).toBe('created');
    unbindJobLifecycleNotifier(db);
  });

  it('does not publish or commit a lifecycle change when the outer helper rolls back', () => {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const notifier = new JobLifecycleNotifier();
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'request-outer-rollback',
      request: { command: 'echo ok', project_root: '.', risk_level: 'safe' },
      initialState: 'created',
    });
    let calls = 0;
    notifier.subscribe(job.id, () => {
      calls += 1;
    });
    bindJobLifecycleNotifier(db, notifier);

    expect(() =>
      runJobLifecycleTransaction(db, () => {
        transitionJobState(db, job.id, 'queued');
        expect(calls).toBe(0);
        throw new Error('outer rollback');
      }),
    ).toThrow('outer rollback');

    expect(calls).toBe(0);
    expect(notifier.listenerCount(job.id)).toBe(1);
    expect(
      (db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state,
    ).toBe('created');
    unbindJobLifecycleNotifier(db);
  });

  it('keeps rollback atomicity when the lifecycle notifier is unbound', () => {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'request-unbound-rollback',
      request: { command: 'echo ok', project_root: '.', risk_level: 'safe' },
      initialState: 'created',
    });

    expect(() =>
      runLifecycleTransaction(db, () => {
        transitionJobState(db, job.id, 'queued');
        throw new Error('unbound rollback');
      }),
    ).toThrow('unbound rollback');

    expect(
      (db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string }).state,
    ).toBe('created');
  });
});
