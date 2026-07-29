import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAttemptLogs, iterIndexedChunksAfter, readChunkIndexEntries } from '@rbo/executor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleRemoteLogChunk } from '../src/execution/remote-execution.js';
import { attemptLogDir } from '../src/execution/runner.js';
import { startControllerServer } from '../src/http/server.js';
import type { RunningControllerServer } from '../src/http/server.js';
import { createJob, getAttempt, transitionJobState } from '../src/jobs/lifecycle.js';
import { LiveLogHub, getLiveLogHub, resetLiveLogHubForTests } from '../src/logs/live-log-hub.js';
import { persistAndPublishLogChunk, setStreamMaxBufferedForTests } from '../src/logs/stream.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function mockSocket(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

function insertAgent(db: ReturnType<typeof openDatabase>, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
     VALUES (?, ?, ?, 'offline', '{}', ?)`,
  ).run(agentId, agentId, 'localhost', nowIso());
}

describe('LiveLogHub', () => {
  it('publishes only to subscribers and drops slow clients without blocking', async () => {
    const hub = new LiveLogHub();
    const fast = hub.subscribe('att_1', { maxBuffered: 10 });
    const slow = hub.subscribe('att_1', { maxBuffered: 1 });

    hub.publish({ attempt_id: 'att_1', sequence: 1, stream: 'stdout', text: 'a' });
    // Fill slow client's buffer then overflow.
    hub.publish({ attempt_id: 'att_1', sequence: 2, stream: 'stdout', text: 'b' });
    hub.publish({ attempt_id: 'att_1', sequence: 3, stream: 'stdout', text: 'c' });

    expect(slow.dropped).toBe(true);
    expect(hub.subscriberCount('att_1')).toBe(1);

    const first = await fast.next();
    expect(first).toMatchObject({ sequence: 1, text: 'a' });
    const second = await fast.next();
    expect(second).toMatchObject({ sequence: 2, text: 'b' });
    const third = await fast.next();
    expect(third).toMatchObject({ sequence: 3, text: 'c' });
    fast.close();
  });

  it('skips already-seen sequences for reconnecting subscribers', async () => {
    const hub = new LiveLogHub();
    const sub = hub.subscribe('att_2', { afterSequence: 5 });
    hub.publish({ attempt_id: 'att_2', sequence: 5, stream: 'stdout', text: 'skip' });
    hub.publish({ attempt_id: 'att_2', sequence: 6, stream: 'stdout', text: 'keep' });
    const item = await sub.next();
    expect(item).toMatchObject({ sequence: 6, text: 'keep' });
    sub.close();
  });

  it('abortable next timeout does not steal a later published event', async () => {
    const hub = new LiveLogHub();
    const sub = hub.subscribe('att_race', { maxBuffered: 10 });
    const ac = new AbortController();
    const waiting = sub.next({ signal: ac.signal });
    // Let the waiter register, then abort (simulates cancelable poll).
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await waiting).toBeNull();
    expect(sub.closed).toBe(false);

    hub.publish({ attempt_id: 'att_race', sequence: 1, stream: 'stdout', text: 'kept' });
    const item = await sub.next();
    expect(item).toMatchObject({ sequence: 1, text: 'kept' });
    sub.close();
  });

  it('rejects concurrent next() waiters', async () => {
    const hub = new LiveLogHub();
    const sub = hub.subscribe('att_conc');
    const first = sub.next();
    await expect(sub.next()).rejects.toThrow(/already waiting/);
    hub.publish({ attempt_id: 'att_conc', sequence: 1, stream: 'stdout', text: 'x' });
    expect(await first).toMatchObject({ sequence: 1 });
    sub.close();
  });
});

describe('persistAndPublishLogChunk + ordered replay', () => {
  let dataDir: string;

  afterEach(async () => {
    resetLiveLogHubForTests();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('writes durable bytes and index before publishing', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-live-persist-'));
    const hub = resetLiveLogHubForTests();
    const sub = hub.subscribe('att_p1', { afterSequence: 0 });

    let publishedBeforeRead = false;
    const nextPromise = sub.next().then((item) => {
      publishedBeforeRead = true;
      return item;
    });

    await persistAndPublishLogChunk({
      dataDir,
      attemptId: 'att_p1',
      stream: 'stdout',
      chunk: 'hello',
      sequence: 1,
    });

    const logDir = attemptLogDir(dataDir, 'att_p1');
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('hello');
    const entries = await readChunkIndexEntries(await ensureAttemptLogs(logDir));
    expect(entries).toEqual([{ sequence: 1, stream: 'stdout', byte_offset: 0, byte_length: 5 }]);

    const item = await nextPromise;
    expect(publishedBeforeRead).toBe(true);
    expect(item).toMatchObject({ sequence: 1, text: 'hello' });
    sub.close();
  });

  it('replays stdout/stderr in sequence order', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-live-order-'));
    await persistAndPublishLogChunk({
      dataDir,
      attemptId: 'att_ord',
      stream: 'stdout',
      chunk: 'out1',
      sequence: 1,
    });
    await persistAndPublishLogChunk({
      dataDir,
      attemptId: 'att_ord',
      stream: 'stderr',
      chunk: 'err1',
      sequence: 2,
    });
    await persistAndPublishLogChunk({
      dataDir,
      attemptId: 'att_ord',
      stream: 'stdout',
      chunk: 'out2',
      sequence: 3,
    });

    const logs = await ensureAttemptLogs(attemptLogDir(dataDir, 'att_ord'));
    const replayed: Array<{ sequence: number; stream: string; text: string }> = [];
    for await (const chunk of iterIndexedChunksAfter(logs, 0)) {
      replayed.push(chunk);
    }
    expect(replayed.map((c) => `${c.sequence}:${c.stream}:${c.text}`)).toEqual([
      '1:stdout:out1',
      '2:stderr:err1',
      '3:stdout:out2',
    ]);
  });
});

describe('SSE log stream reconnect + remote publish', () => {
  let dataDir: string;
  let running: RunningControllerServer | undefined;

  beforeEach(() => {
    resetLiveLogHubForTests();
    setStreamMaxBufferedForTests(undefined);
  });

  afterEach(async () => {
    setStreamMaxBufferedForTests(undefined);
    if (running) {
      await running.close();
      running = undefined;
    }
    resetLiveLogHubForTests();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setupJob() {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-sse-logs-'));
    const db = openDatabase(join(dataDir, 'controller.db'));
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: `req_sse_${Date.now()}`,
      initialState: 'queued',
      request: {
        client_request_id: `req_sse_${Date.now()}`,
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = 'att_sse_1';
    const leaseId = 'lease_sse_1';
    const futureDeadline = new Date(Date.now() + 60_000).toISOString();
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, futureDeadline);

    const socket = mockSocket();
    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        'agt_1',
        {
          agentId: 'agt_1',
          socket,
          protocolVersion: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
    ]);

    const identity = {
      controllerId: 'ctl',
      fingerprint: 'sha256:abc',
      tlsCertPem: '',
      tlsKeyPem: '',
      signingPublicKeyPem: '',
      signingPrivateKeyPem: '',
    };

    const opts = {
      db,
      identity,
      dataDir,
      connectedAgents,
      serverPort: 0,
    };

    running = await startControllerServer({
      // These fixtures use local repos with no allowlisted remote, so overlay
      // capture is impossible; opt in to the full-snapshot path explicitly.
      allowFullSnapshotFallback: true,
      host: '127.0.0.1',
      port: 0,
      db,
      identity,
      dataDir,
      connectedAgents,
    });

    return { db, opts, job, attemptId, leaseId, socket };
  }

  async function readSseUntil(
    url: string,
    headers: Record<string, string>,
    stop: (events: Array<Record<string, unknown>>) => boolean,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers } });
    expect(res.ok).toBe(true);
    expect(res.body).toBeTruthy();
    if (!res.body) {
      throw new Error('missing body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: Array<Record<string, unknown>> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
        const eventLine = block.split(/\r?\n/).find((l) => l.startsWith('event:'));
        if (dataLine) {
          const parsed = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          const eventName = eventLine?.slice(6).trim();
          events.push({ ...parsed, _event: eventName });
          if (stop(events)) {
            reader.cancel().catch(() => undefined);
            return events;
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
    return events;
  }

  it('remote log_chunk indexes + publishes; SSE reconnect skips duplicates via Last-Event-ID', async () => {
    const { db, opts, job, attemptId, leaseId } = await setupJob();

    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'one\n',
    });
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stderr',
      sequence: 2,
      bytes: 'two\n',
    });

    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(2);
    const index = await readFile(join(attemptLogDir(dataDir, attemptId), 'chunks.jsonl'), 'utf8');
    expect(index.trim().split(/\r?\n/)).toHaveLength(2);

    expect(running).toBeTruthy();
    const streamUrl = `http://127.0.0.1:${running.port}/internal/v1/jobs/${job.id}/logs/stream?attempt_id=${attemptId}`;

    // First connect: history replay
    const first = await readSseUntil(streamUrl, {}, (events) => {
      const logs = events.filter((e) => e._event === 'log');
      return logs.length >= 2;
    });
    const firstLogs = first.filter((e) => e._event === 'log');
    expect(firstLogs.map((e) => e.text)).toEqual(['one\n', 'two\n']);

    // Reconnect with Last-Event-ID=2 should not re-deliver 1..2 from replay
    // (empty history after 2); then live publish sequence 3.
    const livePromise = readSseUntil(streamUrl, { 'last-event-id': '2' }, (events) =>
      events.some((e) => e._event === 'log' && e.sequence === 3),
    );

    // Give SSE time to subscribe after history
    await new Promise((r) => setTimeout(r, 50));
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 3,
      bytes: 'three\n',
    });

    const live = await livePromise;
    const liveLogs = live.filter((e) => e._event === 'log');
    expect(liveLogs.map((e) => e.text)).toEqual(['three\n']);
    expect(liveLogs.every((e) => e.sequence !== 1 && e.sequence !== 2)).toBe(true);

    db.close();
  });

  it('subscribe-before-history catch-up delivers chunks published during disk replay window', async () => {
    const { db, opts, job, attemptId, leaseId } = await setupJob();

    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'hist\n',
    });

    expect(running).toBeTruthy();
    const streamUrl = `http://127.0.0.1:${running.port}/internal/v1/jobs/${job.id}/logs/stream?attempt_id=${attemptId}`;

    // Publish sequence 2 as soon as a subscriber appears (history→live gap).
    const gapPromise = (async () => {
      for (let i = 0; i < 200; i++) {
        if (getLiveLogHub().subscriberCount(attemptId) > 0) {
          await handleRemoteLogChunk(opts, 'agt_1', {
            attempt_id: attemptId,
            lease_id: leaseId,
            lease_epoch: 1,
            stream: 'stdout',
            sequence: 2,
            bytes: 'gap\n',
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('subscriber never appeared');
    })();

    const eventsPromise = readSseUntil(streamUrl, {}, (events) => {
      const logs = events.filter((e) => e._event === 'log');
      return logs.some((e) => e.sequence === 2);
    });

    await gapPromise;
    const events = await eventsPromise;
    const texts = events.filter((e) => e._event === 'log').map((e) => e.text);
    expect(texts).toContain('hist\n');
    expect(texts).toContain('gap\n');

    db.close();
  });

  it('terminal drain delivers final live chunks before done', async () => {
    const { db, opts, job, attemptId, leaseId } = await setupJob();

    expect(running).toBeTruthy();
    const streamUrl = `http://127.0.0.1:${running.port}/internal/v1/jobs/${job.id}/logs/stream?attempt_id=${attemptId}`;
    const eventsPromise = readSseUntil(streamUrl, {}, (events) =>
      events.some((e) => e._event === 'done'),
    );

    await new Promise((r) => setTimeout(r, 30));
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'final\n',
    });
    transitionJobState(db, job.id, 'completed', { outcome: 'succeeded' });

    const events = await eventsPromise;
    const logs = events.filter((e) => e._event === 'log');
    const done = events.find((e) => e._event === 'done');
    expect(logs.map((e) => e.text)).toEqual(['final\n']);
    expect(done).toMatchObject({ last_sequence: 1, state: 'completed' });

    db.close();
  });

  it('buffer overflow ends SSE with error so clients can reconnect', async () => {
    setStreamMaxBufferedForTests(1);
    const { db, job, attemptId } = await setupJob();

    expect(running).toBeTruthy();
    const streamUrl = `http://127.0.0.1:${running.port}/internal/v1/jobs/${job.id}/logs/stream?attempt_id=${attemptId}`;
    const eventsPromise = readSseUntil(streamUrl, {}, (events) =>
      events.some((e) => e._event === 'error'),
    );

    for (let i = 0; i < 100; i++) {
      if (getLiveLogHub().subscriberCount(attemptId) > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    // Synchronous burst: second publish overflows maxBuffered=1 before next() drains.
    const hub = getLiveLogHub();
    hub.publish({ attempt_id: attemptId, sequence: 1, stream: 'stdout', text: 'a\n' });
    hub.publish({ attempt_id: attemptId, sequence: 2, stream: 'stdout', text: 'b\n' });
    hub.publish({ attempt_id: attemptId, sequence: 3, stream: 'stdout', text: 'c\n' });

    const events = await eventsPromise;
    const err = events.find((e) => e._event === 'error');
    expect(err).toMatchObject({ code: 'buffer_overflow' });
    expect(events.some((e) => e._event === 'done')).toBe(false);

    db.close();
  });

  it('slow/disconnected SSE clients do not block remote log_ack path', async () => {
    const { db, opts, attemptId, leaseId } = await setupJob();
    const hub = getLiveLogHub();
    const slow = hub.subscribe(attemptId, { maxBuffered: 1 });

    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'a',
    });
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 2,
      bytes: 'b',
    });
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 3,
      bytes: 'c',
    });

    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(3);
    expect(slow.dropped).toBe(true);
    slow.close();
    db.close();
  });

  it('unknown job_id on log stream returns HTTP 400 validation, not 500', async () => {
    const { db } = await setupJob();
    expect(running).toBeTruthy();
    const res = await fetch(
      `http://127.0.0.1:${running.port}/internal/v1/jobs/job_missing/logs/stream`,
      { headers: { accept: 'text/event-stream' } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { category?: string } };
    expect(body.error?.category).toBe('validation');
    db.close();
  });
});
