import type { ControllerDatabase } from '../storage/database.js';

export type JobLifecycleListener = () => void;

/**
 * In-process wakeup primitive for durable job lifecycle state.
 * Subscribers must reread SQLite after a wakeup; this object is not durable
 * state. Completed listener sets are released before callbacks run.
 */
export class JobLifecycleNotifier {
  private readonly listenersByJob = new Map<string, Set<JobLifecycleListener>>();
  private readonly pendingByDatabase = new WeakMap<ControllerDatabase, Set<string>>();
  private readonly activeTransactions = new WeakSet<ControllerDatabase>();
  private closed = false;

  subscribe(jobId: string, listener: JobLifecycleListener): () => void {
    if (this.closed) return () => undefined;
    let listeners = this.listenersByJob.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this.listenersByJob.set(jobId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.listenersByJob.get(jobId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listenersByJob.delete(jobId);
    };
  }

  /** Notify all current waiters and release the completed job's listener set. */
  notify(jobId: string): void {
    if (this.closed) return;
    const listeners = this.listenersByJob.get(jobId);
    if (!listeners) return;
    this.listenersByJob.delete(jobId);
    for (const listener of listeners) listener();
  }

  /** Publish immediately outside a transaction, or queue until runTransaction commits. */
  notifyAfterCommit(db: ControllerDatabase, jobId: string): void {
    if (this.closed) return;
    if (!db.inTransaction) {
      this.notify(jobId);
      return;
    }
    let pending = this.pendingByDatabase.get(db);
    if (!pending) {
      pending = new Set();
      this.pendingByDatabase.set(db, pending);
    }
    pending.add(jobId);
  }

  /** Execute and commit a transaction, publishing queued jobs only after commit. */
  runTransaction<T>(db: ControllerDatabase, operation: () => T): T {
    if (db.inTransaction) {
      throw new Error(
        'Cannot start a job lifecycle transaction inside an existing SQLite transaction; wrap the outer transaction with runJobLifecycleTransaction',
      );
    }
    const transaction = db.transaction(() => {
      this.activeTransactions.add(db);
      try {
        return operation();
      } finally {
        this.activeTransactions.delete(db);
      }
    });
    try {
      const result = transaction();
      const pending = this.pendingByDatabase.get(db);
      this.pendingByDatabase.delete(db);
      for (const jobId of pending ?? []) this.notify(jobId);
      return result;
    } catch (error) {
      this.pendingByDatabase.delete(db);
      throw error;
    }
  }

  isManagedTransaction(db: ControllerDatabase): boolean {
    return this.activeTransactions.has(db);
  }

  listenerCount(jobId?: string): number {
    if (jobId !== undefined) return this.listenersByJob.get(jobId)?.size ?? 0;
    let count = 0;
    for (const listeners of this.listenersByJob.values()) count += listeners.size;
    return count;
  }

  close(): void {
    this.closed = true;
    this.listenersByJob.clear();
  }
}

const notifierByDatabase = new WeakMap<ControllerDatabase, JobLifecycleNotifier>();
const unboundManagedTransactions = new WeakSet<ControllerDatabase>();

/** Attach the runtime-owned notifier to a Controller database. */
export function bindJobLifecycleNotifier(
  db: ControllerDatabase,
  notifier: JobLifecycleNotifier,
): void {
  notifierByDatabase.set(db, notifier);
}

export function unbindJobLifecycleNotifier(db: ControllerDatabase): void {
  notifierByDatabase.delete(db);
}

/**
 * Subscribe through the Controller-owned notifier. This intentionally fails
 * closed when no runtime binding exists so a waiter cannot accidentally attach
 * to an isolated notifier that will never receive lifecycle events.
 */
export function subscribeToJobLifecycle(
  db: ControllerDatabase,
  jobId: string,
  listener: JobLifecycleListener,
): () => void {
  const notifier = notifierByDatabase.get(db);
  if (!notifier) {
    throw new Error('No job lifecycle notifier is bound to this database');
  }
  return notifier.subscribe(jobId, listener);
}

/**
 * Run a lifecycle-owned transaction without exposing the runtime notifier
 * instance. Callers must use this at the outermost transaction boundary so a
 * rollback cannot publish a wakeup and raw SQLite nesting cannot silently
 * lose the pending notification.
 */
export function runJobLifecycleTransaction<T>(db: ControllerDatabase, operation: () => T): T {
  const notifier = notifierByDatabase.get(db);
  if (!notifier) {
    throw new Error('No job lifecycle notifier is bound to this database');
  }
  return notifier.runTransaction(db, operation);
}

/**
 * Execute lifecycle writes atomically for isolated/programmatic callers that
 * do not have a runtime notifier. The managed marker keeps lifecycle guards
 * fail-closed for raw SQLite transactions while intentionally providing no
 * wakeup callbacks.
 */
export function runUnboundJobLifecycleTransaction<T>(
  db: ControllerDatabase,
  operation: () => T,
): T {
  if (db.inTransaction) {
    throw new Error(
      'Cannot start a job lifecycle transaction inside an existing SQLite transaction; wrap the outer transaction with runLifecycleTransaction',
    );
  }
  const transaction = db.transaction(() => {
    unboundManagedTransactions.add(db);
    try {
      return operation();
    } finally {
      unboundManagedTransactions.delete(db);
    }
  });
  return transaction();
}

/** Called by lifecycle writers after a successful durable mutation. */
export function notifyJobLifecycleChanged(db: ControllerDatabase, jobId: string): void {
  notifierByDatabase.get(db)?.notifyAfterCommit(db, jobId);
}

/** Fail closed before a jobs mutation enters an unsupported raw transaction. */
export function assertJobLifecycleWriteAllowed(db: ControllerDatabase): void {
  if (!db.inTransaction) return;
  const notifier = notifierByDatabase.get(db);
  if (notifier?.isManagedTransaction(db) || unboundManagedTransactions.has(db)) return;
  throw new Error(
    'Job lifecycle writes inside a SQLite transaction must use runJobLifecycleTransaction at the outer boundary',
  );
}
