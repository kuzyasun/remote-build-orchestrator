import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendIndexedLogChunk, ensureAttemptLogs } from '@rbo/executor';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attemptLogDir } from '../src/execution/runner.js';
import { type ToolContext, handleToolCall, validateToolInput } from '../src/mcp/handlers.js';
import { type ControllerDatabase, migrateToLatest, openDatabase } from '../src/storage/database.js';

describe('Controller job_logs contract and durable paging', () => {
  let dataDir: string;
  let db: ControllerDatabase;
  let ctx: ToolContext;
  const jobId = 'job_logs_fixture';
  const attemptId = 'att_logs_fixture';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-job-logs-'));
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const identity = await ensureControllerIdentity(dataDir);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO jobs (id, client_id, client_request_id, state, created_at, updated_at, request_json)
      VALUES (?, 'fixture', 'fixture-request', 'running', ?, ?, '{}')`).run(jobId, now, now);
    db.prepare(`INSERT INTO job_attempts (id, job_id, ordinal, lease_id, lease_epoch, state)
      VALUES (?, ?, 1, 'lease_fixture', 1, 'running')`).run(attemptId, jobId);
    ctx = {
      db,
      dataDir,
      controllerIdentity: identity,
      identity: { client_id: 'fixture', transport: 'internal', session_id: null },
    };
    await ensureAttemptLogs(attemptLogDir(dataDir, attemptId));
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function append(stream: 'stdout' | 'stderr', bytes: string | Buffer, sequence: number) {
    await appendIndexedLogChunk(
      await ensureAttemptLogs(attemptLogDir(dataDir, attemptId)),
      stream,
      bytes,
      sequence,
    );
  }

  it('pages alternating durable streams exactly once and strips presentation controls', async () => {
    await append('stdout', '\x1b[31mout-1\x1b[0m', 1);
    await append('stderr', '\x1b]0;title\x07err-1', 2);
    await append('stdout', 'out-2', 3);
    let cursor: string | null = null;
    const received: string[] = [];
    for (let page = 0; page < 10; page += 1) {
      const result = await handleToolCall(ctx, 'job_logs', {
        job_id: jobId,
        attempt_id: attemptId,
        mode: 'logs',
        cursor,
        max_bytes: 4,
      });
      expect(result).not.toHaveProperty('error');
      received.push(...(result.chunks as Array<{ text: string }>).map((chunk) => chunk.text));
      const next = result.next_cursor as string | null;
      if (!result.has_more) break;
      expect(next).toBeTruthy();
      expect(next).not.toBe(cursor);
      cursor = next;
    }
    expect(received.join('')).toBe('out-1err-1out-2');
  });

  it('keeps ANSI carry state isolated when streams alternate', async () => {
    await append('stdout', '\x1b]title', 1);
    await append('stderr', '\x1b]err', 2);

    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 4,
    });
    expect(first).not.toHaveProperty('error');
    expect(first.next_cursor).toEqual(expect.any(String));
    expect((first.next_cursor as string).length).toBeLessThanOrEqual(512);

    await append('stdout', '\x07out', 3);
    await append('stderr', '\x07err', 4);
    const result = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      cursor: first.next_cursor,
      max_bytes: 64,
    });
    expect(result).not.toHaveProperty('error');
    expect((result.chunks as Array<{ text: string }>).map((chunk) => chunk.text).join('')).toBe(
      'outerr',
    );
  });

  it('resumes split UTF-8 scalars without duplication and rejects tampered or mismatched cursors', async () => {
    const scalar = Buffer.from('Ж');
    await append('stdout', Buffer.concat([Buffer.from('a'), scalar.subarray(0, 1)]), 1);
    await append('stdout', Buffer.concat([scalar.subarray(1), Buffer.from('b')]), 2);
    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 4,
    });
    expect(first).not.toHaveProperty('error');
    const cursor = first.next_cursor as string;
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect((first.chunks as Array<{ sequence: number }>).map((chunk) => chunk.sequence)).toEqual([
      1,
    ]);
    const replay = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      cursor,
      max_bytes: 4,
    });
    expect(
      (replay.chunks as Array<{ text: string; sequence: number }>).map((x) => x.text).join(''),
    ).toBe('Ж');
    expect((replay.chunks as Array<{ sequence: number }>).map((chunk) => chunk.sequence)).toEqual([
      1,
    ]);
    const tail = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      mode: 'logs',
      cursor: replay.next_cursor,
      max_bytes: 4,
    });
    expect(
      (tail.chunks as Array<{ text: string; sequence: number }>).map((x) => x.text).join(''),
    ).toBe('b');
    expect((tail.chunks as Array<{ sequence: number }>).map((chunk) => chunk.sequence)).toEqual([
      2,
    ]);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    expect(
      (await handleToolCall(ctx, 'job_logs', { job_id: jobId, mode: 'logs', cursor: tampered }))
        .error,
    ).toBeTruthy();
    expect(
      (
        await handleToolCall(ctx, 'job_logs', {
          job_id: jobId,
          attempt_id: 'wrong',
          mode: 'logs',
          cursor,
        })
      ).error,
    ).toBeTruthy();
  });

  it('does not replay or livelock a split scalar when another stream intervenes', async () => {
    const scalar = Buffer.from('Ж');
    await append('stdout', scalar.subarray(0, 1), 1);
    await append('stderr', 'err', 2);
    await append('stdout', scalar.subarray(1), 3);

    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 4,
    });
    expect(first).not.toHaveProperty('error');
    expect(
      (first.chunks as Array<{ sequence: number; text: string }>).map((chunk) => chunk.text),
    ).toEqual(['Ж']);
    expect((first.chunks as Array<{ sequence: number }>).map((chunk) => chunk.sequence)).toEqual([
      1,
    ]);
    expect(first.has_more).toBe(true);

    const second = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      mode: 'logs',
      cursor: first.next_cursor,
      max_bytes: 4,
    });
    expect(second).not.toHaveProperty('error');
    expect(
      (second.chunks as Array<{ sequence: number; text: string }>).map((chunk) => chunk.text),
    ).toEqual(['err']);
    expect((second.chunks as Array<{ sequence: number }>).map((chunk) => chunk.sequence)).toEqual([
      2,
    ]);
    expect(second.has_more).toBe(false);
    const done = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      mode: 'logs',
      cursor: second.next_cursor,
      max_bytes: 4,
    });
    expect(done.chunks).toEqual([]);
    expect(done.has_more).toBe(false);
  });

  it('pages past a quiet stream when the other stream continues beyond one page', async () => {
    await append('stderr', 'err-1\n', 1);
    for (let sequence = 2; sequence <= 201; sequence += 1) {
      await append('stdout', `out-${sequence}\n`, sequence);
    }
    const received: Array<{ sequence: number; stream: string; text: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await handleToolCall(ctx, 'job_logs', {
        job_id: jobId,
        attempt_id: attemptId,
        mode: 'logs',
        cursor,
        max_bytes: 4096,
      });
      expect(result).not.toHaveProperty('error');
      const chunks = result.chunks as Array<{ sequence: number; stream: string; text: string }>;
      received.push(...chunks);
      if (!result.has_more) break;
      expect(result.next_cursor).toEqual(expect.any(String));
      expect(result.next_cursor).not.toBe(cursor);
      cursor = result.next_cursor as string;
    }
    expect(received.map((chunk) => chunk.sequence)).toEqual(
      Array.from({ length: 201 }, (_, index) => index + 1),
    );
    expect(received[0]).toMatchObject({ stream: 'stderr', text: 'err-1\n' });
    expect(received.at(-1)).toMatchObject({ stream: 'stdout', text: 'out-201\n' });
  });

  it('bounds pages to 128 chunks and returns a structured error when a source disappears', async () => {
    for (let sequence = 1; sequence <= 130; sequence += 1)
      await append('stdout', `x${sequence},`, sequence);
    const page = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 4096,
    });
    expect((page.chunks as Array<unknown>).length).toBeLessThanOrEqual(128);
    expect(page.has_more).toBe(true);
    const logPath = join(attemptLogDir(dataDir, attemptId), 'stdout.log');
    await rm(logPath);
    const missing = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 16,
    });
    expect(missing).toMatchObject({ error: { category: 'validation', retryable: false } });
  });

  it('resumes a later opaque cursor through sparse checkpoints without skipping the suffix', async () => {
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      await append('stdout', `chunk-${sequence}\n`, sequence);
    }
    const checkpointPath = join(attemptLogDir(dataDir, attemptId), 'chunks.checkpoints.jsonl');
    const checkpoints = await readFile(checkpointPath, 'utf8');
    expect(checkpoints).toContain('"sequence":127');
    expect(checkpoints).toContain('"sequence":255');

    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 4096,
    });
    expect(first).not.toHaveProperty('error');
    expect((first.chunks as Array<{ sequence: number }>).map((chunk) => chunk.sequence)).toEqual(
      Array.from({ length: 128 }, (_, index) => index + 1),
    );
    expect(first.next_cursor).toEqual(expect.any(String));

    const resumed: Array<{ sequence: number; text: string }> = [];
    let cursor = first.next_cursor as string;
    for (;;) {
      const page = await handleToolCall(ctx, 'job_logs', {
        job_id: jobId,
        attempt_id: attemptId,
        mode: 'logs',
        cursor,
        max_bytes: 4096,
      });
      expect(page).not.toHaveProperty('error');
      resumed.push(...(page.chunks as Array<{ sequence: number; text: string }>));
      if (!page.has_more) break;
      expect(page.next_cursor).toEqual(expect.any(String));
      cursor = page.next_cursor as string;
    }
    expect(resumed.map((chunk) => chunk.sequence)).toEqual(
      Array.from({ length: 172 }, (_, index) => index + 129),
    );
    expect(resumed.map((chunk) => chunk.text).join('')).toBe(
      Array.from({ length: 172 }, (_, index) => `chunk-${index + 129}\n`).join(''),
    );
  });

  it('keeps an old cursor bound to its original attempt after a retry and survives a new context', async () => {
    await append('stdout', 'old', 1);
    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'logs',
      max_bytes: 4,
    });
    const cursor = first.next_cursor as string;
    db.prepare(`INSERT INTO job_attempts (id, job_id, ordinal, lease_id, lease_epoch, state)
      VALUES ('att_logs_retry', ?, 2, 'lease_retry', 2, 'running')`).run(jobId);
    const fresh = { ...ctx, identity: { ...ctx.identity, transport: 'http' as const } };
    const replay = await handleToolCall(fresh, 'job_logs', {
      job_id: jobId,
      mode: 'logs',
      cursor,
      max_bytes: 4,
    });
    expect((replay.chunks as Array<{ text: string }>).map((x) => x.text).join('')).toBe('');
    expect(replay.attempt_id).toBe(attemptId);
  });

  it('advances over malformed events and keeps event/log cursors separate', async () => {
    const path = join(attemptLogDir(dataDir, attemptId), 'events.jsonl');
    const event = {
      type: 'state_transition',
      job_id: jobId,
      attempt_id: attemptId,
      sequence: 1,
      created_at: new Date().toISOString(),
      from_state: 'running',
      to_state: 'completed',
    };
    await writeFile(path, `not-json\n${JSON.stringify(event)}\n`, 'utf8');
    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'events',
      max_bytes: 256,
    });
    expect(first).not.toHaveProperty('error');
    expect(first.events).toHaveLength(1);
    const next = first.next_cursor as string;
    const second = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      mode: 'events',
      cursor: next,
      max_bytes: 256,
    });
    expect(second.events).toEqual([]);
    expect(
      (await handleToolCall(ctx, 'job_logs', { job_id: jobId, mode: 'logs', cursor: next })).error,
    ).toBeTruthy();
  });

  it('issues an advancing signed cursor for a malformed-only event page', async () => {
    const path = join(attemptLogDir(dataDir, attemptId), 'events.jsonl');
    await writeFile(path, 'not-json\n', 'utf8');
    const first = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'events',
      max_bytes: 256,
    });
    expect(first.events).toEqual([]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.next_cursor).not.toBeNull();
    const second = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      mode: 'events',
      cursor: first.next_cursor,
      max_bytes: 256,
    });
    expect(second.events).toEqual([]);
    expect(second.next_cursor).toBe(first.next_cursor);
  });

  it('rejects a valid event larger than the page budget without a retry loop', async () => {
    const path = join(attemptLogDir(dataDir, attemptId), 'events.jsonl');
    const event = {
      type: 'error',
      job_id: jobId,
      attempt_id: attemptId,
      sequence: 1,
      created_at: new Date().toISOString(),
      category: 'internal',
      message: 'x'.repeat(100),
    };
    await writeFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    const result = await handleToolCall(ctx, 'job_logs', {
      job_id: jobId,
      attempt_id: attemptId,
      mode: 'events',
      max_bytes: 4,
    });
    expect(result).toMatchObject({ error: { category: 'validation', retryable: false } });
    expect(result).not.toHaveProperty('events');
    expect(result).not.toHaveProperty('next_cursor');
  });

  it('rejects numeric/legacy and out-of-budget inputs', () => {
    expect(() =>
      validateToolInput('job_logs', { job_id: jobId, mode: 'logs', cursor: 0 }),
    ).toThrow();
    expect(() =>
      validateToolInput('job_logs', { job_id: jobId, mode: 'logs', streams: ['stdout'] }),
    ).toThrow();
    expect(() =>
      validateToolInput('job_logs', { job_id: jobId, mode: 'logs', max_bytes: 3 }),
    ).toThrow();
  });
});
