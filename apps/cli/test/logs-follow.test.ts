import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { followJobLogsRemote, getJobLogsRemote } from '../src/commands/jobs.js';

describe('CLI job logs helpers', () => {
  it('getJobLogsRemote defaults to logs mode with an opaque null cursor', async () => {
    let body: Record<string, unknown> | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            job_id: 'job_1',
            attempt_id: 'att_1',
            mode: 'logs',
            chunks: [{ sequence: 1, stream: 'stdout', text: 'hi', complete: true }],
            next_cursor: 'opaque-2',
            has_more: false,
          }),
        );
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await getJobLogsRemote(`http://127.0.0.1:${port}`, 'job_1');
    expect(body?.mode).toBe('logs');
    expect(body?.cursor).toBeNull();
    expect(body).not.toHaveProperty('streams');
    expect(result.mode).toBe('logs');
    expect(result.next_cursor).toBe('opaque-2');

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });

  it('accepts and forwards opaque cursors without numeric coercion', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        requests.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ mode: 'logs', chunks: [], next_cursor: 'signed.next', has_more: false }),
        );
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    await getJobLogsRemote(`http://127.0.0.1:${port}`, 'job_1', {
      mode: 'logs',
      cursor: 'signed.cursor.with.dots',
      max_bytes: 4096,
    });
    expect(requests[0]).toMatchObject({
      mode: 'logs',
      cursor: 'signed.cursor.with.dots',
      max_bytes: 4096,
    });
    expect(requests[0]).not.toHaveProperty('streams');

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });

  it('followJobLogsRemote prints text, reconnects with Last-Event-ID, exits on done', async () => {
    let connections = 0;
    const receivedHeaders: Array<string | undefined> = [];
    const printed: string[] = [];

    const server = createServer((req, res) => {
      if (req.url?.startsWith('/internal/v1/tools/job_get')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // Stay non-terminal until the second SSE connection finishes with done.
        // Real controller job_get returns `{ job: { state, ... } }`.
        const state = connections >= 2 ? 'completed' : 'running';
        res.end(
          JSON.stringify({
            job: {
              id: 'job_1',
              state,
              outcome: state === 'completed' ? 'succeeded' : null,
            },
          }),
        );
        return;
      }
      if (!req.url?.includes('/logs/stream')) {
        res.writeHead(404).end();
        return;
      }
      connections += 1;
      receivedHeaders.push(
        typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (connections === 1) {
        res.write(
          'event: log\nid: 1\ndata: {"attempt_id":"att","sequence":1,"stream":"stdout","text":"a"}\n\n',
        );
        // Drop connection to force reconnect
        res.end();
        return;
      }
      res.write(
        'event: log\nid: 2\ndata: {"attempt_id":"att","sequence":2,"stream":"stdout","text":"b"}\n\n',
      );
      res.write(
        'event: done\ndata: {"attempt_id":"att","job_id":"job_1","state":"completed","outcome":"succeeded","last_sequence":2}\n\n',
      );
      res.end();
    });

    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await followJobLogsRemote(`http://127.0.0.1:${port}`, 'job_1', {
      onChunk: (_stream, text) => printed.push(text),
      pollMs: 10,
    });

    expect(printed.join('')).toBe('ab');
    expect(result.lastSequence).toBe(2);
    expect(result.state).toBe('completed');
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(receivedHeaders[1]).toBe('1');

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });

  it('followJobLogsRemote reconnects after stream drop to catch missed tail + done', async () => {
    let connections = 0;
    const printed: string[] = [];
    const receivedHeaders: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/internal/v1/tools/job_get')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job: { id: 'job_1', state: 'completed', outcome: 'succeeded' } }));
        return;
      }
      if (!req.url?.includes('/logs/stream')) {
        res.writeHead(404).end();
        return;
      }
      connections += 1;
      receivedHeaders.push(
        typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (connections === 1) {
        res.write(
          'event: log\nid: 1\ndata: {"attempt_id":"att","sequence":1,"stream":"stdout","text":"x"}\n\n',
        );
        // Drop without done — follow must reconnect for catch-up even though job is terminal.
        res.end();
        return;
      }
      res.write(
        'event: log\nid: 2\ndata: {"attempt_id":"att","sequence":2,"stream":"stdout","text":"y"}\n\n',
      );
      res.write(
        'event: done\ndata: {"attempt_id":"att","job_id":"job_1","state":"completed","outcome":"succeeded","last_sequence":2}\n\n',
      );
      res.end();
    });

    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await followJobLogsRemote(`http://127.0.0.1:${port}`, 'job_1', {
      onChunk: (_stream, text) => printed.push(text),
      pollMs: 10,
    });

    expect(printed.join('')).toBe('xy');
    expect(result.lastSequence).toBe(2);
    expect(result.state).toBe('completed');
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(receivedHeaders[1]).toBe('1');

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });

  it('followJobLogsRemote reconnects after buffer_overflow error event', async () => {
    let connections = 0;
    const receivedHeaders: Array<string | undefined> = [];
    const printed: string[] = [];

    const server = createServer((req, res) => {
      if (req.url?.startsWith('/internal/v1/tools/job_get')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            job: { id: 'job_1', state: connections >= 2 ? 'completed' : 'running', outcome: null },
          }),
        );
        return;
      }
      if (!req.url?.includes('/logs/stream')) {
        res.writeHead(404).end();
        return;
      }
      connections += 1;
      receivedHeaders.push(
        typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (connections === 1) {
        res.write(
          'event: log\nid: 1\ndata: {"attempt_id":"att","sequence":1,"stream":"stdout","text":"a"}\n\n',
        );
        res.write(
          'event: error\ndata: {"code":"buffer_overflow","last_sequence":1,"attempt_id":"att"}\n\n',
        );
        res.end();
        return;
      }
      res.write(
        'event: log\nid: 2\ndata: {"attempt_id":"att","sequence":2,"stream":"stdout","text":"b"}\n\n',
      );
      res.write(
        'event: done\ndata: {"attempt_id":"att","job_id":"job_1","state":"completed","outcome":"succeeded","last_sequence":2}\n\n',
      );
      res.end();
    });

    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await followJobLogsRemote(`http://127.0.0.1:${port}`, 'job_1', {
      onChunk: (_stream, text) => printed.push(text),
      pollMs: 10,
    });

    expect(printed.join('')).toBe('ab');
    expect(result.lastSequence).toBe(2);
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(receivedHeaders[1]).toBe('1');

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });

  it('bounds a stalled SSE connection attempt before reconnecting', async () => {
    let connections = 0;
    const printed: string[] = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/internal/v1/tools/job_get')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job: { id: 'job_1', state: 'completed' } }));
        return;
      }
      if (!req.url?.includes('/logs/stream')) {
        res.writeHead(404).end();
        return;
      }
      connections += 1;
      if (connections === 1) {
        // Deliberately never send response headers; the client must abort this attempt.
        req.on('close', () => res.end());
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          'event: log\nid: 1\ndata: {"sequence":1,"stream":"stdout","text":"tail"}\n\n',
          'event: done\ndata: {"state":"completed","last_sequence":1}\n\n',
        ].join(''),
      );
    });

    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await followJobLogsRemote(`http://127.0.0.1:${port}`, 'job_1', {
      onChunk: (_stream, text) => printed.push(text),
      pollMs: 1,
      connectTimeoutMs: 20,
    });

    expect(printed).toEqual(['tail']);
    expect(result).toEqual({ lastSequence: 1, state: 'completed' });
    expect(connections).toBe(2);

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });

  it('aborts a pending catch-up job_get promptly after an SSE reconnect failure', async () => {
    const controller = new AbortController();
    let jobGetRequests = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/internal/v1/tools/job_get')) {
        jobGetRequests += 1;
        controller.abort();
        // The request must be aborted by the lifecycle signal, rather than waiting for its 15s bound.
        req.on('close', () => res.end());
        return;
      }
      if (req.url?.includes('/logs/stream')) {
        req.socket.destroy();
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const startedAt = Date.now();

    const result = await followJobLogsRemote(`http://127.0.0.1:${port}`, 'job_abort_get', {
      signal: controller.signal,
      pollMs: 1,
    });

    expect(result).toEqual({ lastSequence: 0, state: null });
    expect(jobGetRequests).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((err) => (err ? rejectPromise(err) : resolvePromise())),
    );
  });
});
