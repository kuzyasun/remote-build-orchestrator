/**
 * In-memory pub/sub for live job log viewing (SSE / CLI --follow).
 * Observer-only: never blocks Agent↔Controller log reliability.
 */

export interface LiveLogEvent {
  attempt_id: string;
  sequence: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export type LiveLogHubItem = LiveLogEvent | { type: 'heartbeat' };

const DEFAULT_MAX_BUFFERED_EVENTS = 256;

interface SubscriberState {
  id: number;
  attemptId: string;
  /** Deliver events with sequence > afterSequence. */
  afterSequence: number;
  maxBuffered: number;
  queue: LiveLogHubItem[];
  dropped: boolean;
  closed: boolean;
  /** At most one outstanding waiter; overwritten waiters would lose wakeups. */
  wake: (() => void) | null;
}

export interface LiveLogNextOptions {
  /** When aborted, settle without consuming a queued item (timeout / cancel). */
  signal?: AbortSignal;
}

export interface LiveLogSubscription {
  readonly attemptId: string;
  readonly dropped: boolean;
  readonly closed: boolean;
  /**
   * Pull next live item. Resolves with an event/heartbeat, or null when the
   * subscription is closed/dropped or `options.signal` aborts while the queue
   * is empty. Concurrent `next()` calls are rejected.
   */
  next(options?: LiveLogNextOptions): Promise<LiveLogHubItem | null>;
  close(): void;
}

let nextSubscriberId = 1;

export class LiveLogHub {
  private readonly byAttempt = new Map<string, Set<SubscriberState>>();

  subscribe(
    attemptId: string,
    options?: { afterSequence?: number; maxBuffered?: number },
  ): LiveLogSubscription {
    const state: SubscriberState = {
      id: nextSubscriberId++,
      attemptId,
      afterSequence: options?.afterSequence ?? 0,
      maxBuffered: options?.maxBuffered ?? DEFAULT_MAX_BUFFERED_EVENTS,
      queue: [],
      dropped: false,
      closed: false,
      wake: null,
    };
    let set = this.byAttempt.get(attemptId);
    if (!set) {
      set = new Set();
      this.byAttempt.set(attemptId, set);
    }
    set.add(state);

    const close = () => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      const group = this.byAttempt.get(attemptId);
      group?.delete(state);
      if (group && group.size === 0) {
        this.byAttempt.delete(attemptId);
      }
      const wake = state.wake;
      state.wake = null;
      wake?.();
    };

    return {
      attemptId,
      get dropped() {
        return state.dropped;
      },
      get closed() {
        return state.closed;
      },
      next: async (nextOptions?: LiveLogNextOptions) => {
        const signal = nextOptions?.signal;
        while (!state.closed) {
          const item = state.queue.shift();
          if (item) {
            return item;
          }
          if (signal?.aborted) {
            return null;
          }
          if (state.wake) {
            throw new Error('LiveLogSubscription.next() already waiting');
          }
          await new Promise<void>((resolvePromise) => {
            const finish = () => {
              signal?.removeEventListener('abort', onAbort);
              if (state.wake === wakeFn) {
                state.wake = null;
              }
              resolvePromise();
            };
            const wakeFn = () => {
              finish();
            };
            const onAbort = () => {
              finish();
            };
            state.wake = wakeFn;
            if (signal) {
              signal.addEventListener('abort', onAbort, { once: true });
              // Aborted between the earlier check and listener registration.
              if (signal.aborted) {
                finish();
              }
            }
          });
        }
        return null;
      },
      close,
    };
  }

  /**
   * Fan-out after durable persist. Slow clients that exceed maxBuffered are
   * dropped (closed) so job execution is never blocked by viewers.
   */
  publish(event: LiveLogEvent): void {
    const group = this.byAttempt.get(event.attempt_id);
    if (!group || group.size === 0) {
      return;
    }
    for (const state of [...group]) {
      if (state.closed || state.dropped) {
        continue;
      }
      if (event.sequence <= state.afterSequence) {
        continue;
      }
      state.afterSequence = event.sequence;
      if (state.queue.length >= state.maxBuffered) {
        state.dropped = true;
        state.closed = true;
        group.delete(state);
        const wake = state.wake;
        state.wake = null;
        wake?.();
        continue;
      }
      state.queue.push(event);
      const wake = state.wake;
      state.wake = null;
      wake?.();
    }
    if (group.size === 0) {
      this.byAttempt.delete(event.attempt_id);
    }
  }

  /** Push a heartbeat to all subscribers of an attempt (or all if omitted). */
  heartbeat(attemptId?: string): void {
    const groups = attemptId
      ? [this.byAttempt.get(attemptId)].filter((g): g is Set<SubscriberState> => Boolean(g))
      : [...this.byAttempt.values()];
    for (const group of groups) {
      for (const state of group) {
        if (state.closed || state.dropped) {
          continue;
        }
        if (state.queue.length >= state.maxBuffered) {
          continue;
        }
        state.queue.push({ type: 'heartbeat' });
        const wake = state.wake;
        state.wake = null;
        wake?.();
      }
    }
  }

  /** Test helper: number of active subscribers for an attempt. */
  subscriberCount(attemptId: string): number {
    return this.byAttempt.get(attemptId)?.size ?? 0;
  }
}

let sharedHub: LiveLogHub | undefined;

export function getLiveLogHub(): LiveLogHub {
  if (!sharedHub) {
    sharedHub = new LiveLogHub();
  }
  return sharedHub;
}

/** Reset singleton between tests. */
export function resetLiveLogHubForTests(): LiveLogHub {
  sharedHub = new LiveLogHub();
  return sharedHub;
}
