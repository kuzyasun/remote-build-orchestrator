import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { appendIndexedLogChunk, ensureAttemptLogs, iterIndexedChunksAfter } from '@rbo/executor';
import { RboError } from '@rbo/shared';
import { getAttempt, getJob, getLatestAttempt, isTerminalJobState } from '../jobs/lifecycle.js';
import type { ControllerDatabase } from '../storage/database.js';
import {
  type LiveLogEvent,
  type LiveLogHubItem,
  type LiveLogSubscription,
  getLiveLogHub,
} from './live-log-hub.js';

const SSE_HEARTBEAT_MS = 15_000;
const TERMINAL_POLL_MS = 50;
const DEFAULT_MAX_BUFFERED = 256;

/** Test-only override for slow-client overflow coverage. */
let streamMaxBufferedForTests: number | undefined;

export function setStreamMaxBufferedForTests(value?: number): void {
  streamMaxBufferedForTests = value;
}

function attemptLogsPath(dataDir: string, attemptId: string): string {
  return join(dataDir, 'attempts', attemptId, 'logs');
}

export async function persistAndPublishLogChunk(input: {
  dataDir: string;
  attemptId: string;
  stream: 'stdout' | 'stderr';
  chunk: string | Buffer;
  sequence: number;
}): Promise<LiveLogEvent> {
  const logs = await ensureAttemptLogs(attemptLogsPath(input.dataDir, input.attemptId));
  const { text } = await appendIndexedLogChunk(logs, input.stream, input.chunk, input.sequence);
  const event: LiveLogEvent = {
    attempt_id: input.attemptId,
    sequence: input.sequence,
    stream: input.stream,
    text,
  };
  getLiveLogHub().publish(event);
  return event;
}

function parseLastEventId(req: IncomingMessage, url: URL): number {
  const header = req.headers['last-event-id'];
  const fromHeader = typeof header === 'string' ? Number.parseInt(header, 10) : Number.NaN;
  if (Number.isFinite(fromHeader) && fromHeader >= 0) {
    return fromHeader;
  }
  const fromQuery = Number.parseInt(url.searchParams.get('after_sequence') ?? '', 10);
  if (Number.isFinite(fromQuery) && fromQuery >= 0) {
    return fromQuery;
  }
  return 0;
}

async function writeSsePayload(res: ServerResponse, payload: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  try {
    if (res.write(payload)) {
      return true;
    }
  } catch {
    return false;
  }

  return new Promise((resolvePromise) => {
    const finish = (writable: boolean) => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      resolvePromise(writable && !res.writableEnded && !res.destroyed);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (res.writableEnded || res.destroyed) {
      finish(false);
    }
  });
}

function formatSseEvent(event: { id?: number; event?: string; data: unknown }): string {
  const lines: string[] = [];
  if (event.id != null) {
    lines.push(`id: ${event.id}`);
  }
  if (event.event) {
    lines.push(`event: ${event.event}`);
  }
  lines.push(`data: ${JSON.stringify(event.data)}`, '', '');
  return lines.join('\n');
}

function formatLogEvent(event: {
  attempt_id: string;
  sequence: number;
  stream: 'stdout' | 'stderr';
  text: string;
}): string {
  return formatSseEvent({
    id: event.sequence,
    event: 'log',
    data: {
      attempt_id: event.attempt_id,
      sequence: event.sequence,
      stream: event.stream,
      text: event.text,
    },
  });
}

/** Wait for next hub item, or settle null when `ms` elapses — without abandoning the waiter. */
async function nextWithTimeout(
  subscription: LiveLogSubscription,
  ms: number,
): Promise<{ item: LiveLogHubItem | null; timedOut: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const item = await subscription.next({ signal: ac.signal });
    return { item, timedOut: item === null && ac.signal.aborted && !subscription.closed };
  } finally {
    clearTimeout(timer);
  }
}

/** Non-blocking drain of already-queued hub items (aborted signal → no wait). */
async function drainQueued(subscription: LiveLogSubscription): Promise<LiveLogHubItem[]> {
  const drained: LiveLogHubItem[] = [];
  const aborted = AbortSignal.abort();
  while (!subscription.closed) {
    const item = await subscription.next({ signal: aborted });
    if (!item) {
      break;
    }
    drained.push(item);
  }
  return drained;
}

/**
 * Loopback-only SSE: subscribe first, catch up from chunks.jsonl, then live LiveLogHub.
 * Exits when the client disconnects, the subscription is dropped (overflow), or the job
 * reaches a terminal state after a final drain.
 */
export async function handleJobLogsStreamRequest(input: {
  req: IncomingMessage;
  res: ServerResponse;
  db: ControllerDatabase;
  dataDir: string;
  jobId: string;
  url: URL;
}): Promise<void> {
  const { req, res, db, dataDir, jobId, url } = input;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw RboError.validation('GET required for log stream');
  }

  const job = getJob(db, jobId);
  if (!job) {
    throw RboError.validation(`Unknown job_id '${jobId}'`);
  }

  const attemptIdParam = url.searchParams.get('attempt_id');
  const attempt =
    (attemptIdParam ? getAttempt(db, attemptIdParam) : null) ?? getLatestAttempt(db, jobId);
  if (!attempt || attempt.job_id !== jobId) {
    throw RboError.validation('No attempt found for job');
  }

  const afterSequence = parseLastEventId(req, url);
  const logs = await ensureAttemptLogs(attemptLogsPath(dataDir, attempt.id));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  // Keep all response writes serialized. This makes a slow client apply
  // backpressure to its hub subscription instead of ServerResponse buffering
  // an unbounded number of log events in memory.
  let writeChain: Promise<boolean> = Promise.resolve(true);
  const enqueueSsePayload = (payload: string): Promise<boolean> => {
    writeChain = writeChain.then((writable) =>
      writable ? writeSsePayload(res, payload) : Promise.resolve(false),
    );
    return writeChain;
  };
  const enqueueSseEvent = (event: { id?: number; event?: string; data: unknown }) =>
    enqueueSsePayload(formatSseEvent(event));
  const enqueueLogEvent = (event: {
    attempt_id: string;
    sequence: number;
    stream: 'stdout' | 'stderr';
    text: string;
  }) => enqueueSsePayload(formatLogEvent(event));

  // Hint to flush immediately on some proxies.
  if (!(await enqueueSsePayload(': ok\n\n'))) {
    return;
  }

  // Subscribe before disk catch-up so chunks published during replay are not lost.
  let lastSent = afterSequence;
  const hub = getLiveLogHub();
  const subscription = hub.subscribe(attempt.id, {
    afterSequence,
    maxBuffered: streamMaxBufferedForTests ?? DEFAULT_MAX_BUFFERED,
  });
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const onClose = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    subscription.close();
  };
  // A client can disconnect while historical chunks are being replayed.
  // Register cleanup before that replay so the transition to live streaming
  // cannot miss the close event and leave an SSE request open indefinitely.
  req.once('close', onClose);
  res.once('close', onClose);

  for await (const chunk of iterIndexedChunksAfter(logs, lastSent)) {
    if (res.writableEnded || req.destroyed) {
      subscription.close();
      return;
    }
    if (
      !(await enqueueLogEvent({
        attempt_id: attempt.id,
        sequence: chunk.sequence,
        stream: chunk.stream,
        text: chunk.text,
      }))
    ) {
      subscription.close();
      return;
    }
    lastSent = chunk.sequence;
  }

  let heartbeatQueued = false;
  heartbeat = setInterval(() => {
    if (res.writableEnded || req.destroyed || heartbeatQueued) {
      return;
    }
    heartbeatQueued = true;
    void enqueueSseEvent({ event: 'heartbeat', data: { attempt_id: attempt.id } }).finally(() => {
      heartbeatQueued = false;
    });
  }, SSE_HEARTBEAT_MS);

  const emitOverflowAndEnd = () =>
    enqueueSseEvent({
      event: 'error',
      data: {
        code: 'buffer_overflow',
        attempt_id: attempt.id,
        job_id: jobId,
        last_sequence: lastSent,
        message: 'Live log buffer overflow; reconnect with Last-Event-ID',
      },
    });

  const finishTerminal = async () => {
    // Quiet-loop drain: hub then disk, repeat until two consecutive rounds
    // produce no new sequences (covers late persistAndPublish after first pass).
    let quietRounds = 0;
    while (quietRounds < 2 && !res.writableEnded && !req.destroyed) {
      let progressed = false;
      for (const item of await drainQueued(subscription)) {
        if (!('sequence' in item) || item.sequence <= lastSent) {
          continue;
        }
        if (!(await enqueueLogEvent(item))) {
          return;
        }
        lastSent = item.sequence;
        progressed = true;
      }
      for await (const chunk of iterIndexedChunksAfter(logs, lastSent)) {
        if (res.writableEnded || req.destroyed) {
          return;
        }
        if (
          !(await enqueueLogEvent({
            attempt_id: attempt.id,
            sequence: chunk.sequence,
            stream: chunk.stream,
            text: chunk.text,
          }))
        ) {
          return;
        }
        lastSent = chunk.sequence;
        progressed = true;
      }
      if (progressed) {
        quietRounds = 0;
      } else {
        quietRounds += 1;
        if (quietRounds < 2) {
          await new Promise((r) => setTimeout(r, TERMINAL_POLL_MS));
        }
      }
    }
    if (res.writableEnded || req.destroyed) {
      return;
    }
    const latestJob = getJob(db, jobId);
    await enqueueSseEvent({
      event: 'done',
      data: {
        attempt_id: attempt.id,
        job_id: jobId,
        state: latestJob?.state ?? 'unknown',
        outcome: latestJob?.outcome ?? null,
        last_sequence: lastSent,
      },
    });
  };

  try {
    while (!res.writableEnded && !req.destroyed) {
      const latestJob = getJob(db, jobId);
      const terminal = latestJob ? isTerminalJobState(latestJob.state) : true;
      const waitMs = terminal ? TERMINAL_POLL_MS : SSE_HEARTBEAT_MS;

      const { item, timedOut } = await nextWithTimeout(subscription, waitMs);

      if (res.writableEnded || req.destroyed) {
        break;
      }

      if (item && 'type' in item && item.type === 'heartbeat') {
        if (!(await enqueueSseEvent({ event: 'heartbeat', data: { attempt_id: attempt.id } }))) {
          break;
        }
        continue;
      }
      if (item && 'sequence' in item) {
        if (item.sequence > lastSent) {
          if (!(await enqueueLogEvent(item))) {
            break;
          }
          lastSent = item.sequence;
        }
        continue;
      }

      // null: overflow drop, client close, or cancelable timeout.
      if (subscription.dropped) {
        await emitOverflowAndEnd();
        break;
      }
      if (!timedOut) {
        // Subscription closed (client disconnect / cleanup).
        break;
      }
      if (terminal) {
        await finishTerminal();
        break;
      }
    }
  } finally {
    onClose();
    if (!res.writableEnded) {
      res.end();
    }
  }
}
