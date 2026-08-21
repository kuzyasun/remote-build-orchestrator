import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runJobToTerminal, takeRunFollowFlag } from '../src/commands/run-runtime.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(
  req: Parameters<ReturnType<typeof createServer>['emit']>[1],
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('rbo run runtime', () => {
  it('recognizes --follow only before the target-shell command separator', () => {
    expect(takeRunFollowFlag(['--follow', '--shell', 'bash', '--', 'pnpm test'])).toEqual({
      follow: true,
      args: ['--shell', 'bash', '--', 'pnpm test'],
    });
    expect(takeRunFollowFlag(['--', '--follow'])).toEqual({
      follow: false,
      args: ['--', '--follow'],
    });
  });

  it('keeps bounded compact job_run resume requests until terminal without a CLI deadline', async () => {
    const requests: unknown[] = [];
    const baseUrl = await listen(
      createServer(async (req, res) => {
        if (req.url !== '/internal/v1/tools/job_run') return res.writeHead(404).end();
        requests.push(await readJson(req));
        const response =
          requests.length < 3
            ? { job_id: 'job_1', state: 'running', resume: true }
            : { job_id: 'job_1', state: 'completed', outcome: 'succeeded', exit_code: 0 };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      }),
    );

    await expect(
      runJobToTerminal(baseUrl, { command: 'pnpm test', project_root: '/work/project', cwd: '.' }),
    ).resolves.toEqual({ job_id: 'job_1', state: 'completed', outcome: 'succeeded', exit_code: 0 });

    expect(requests).toEqual([
      { command: 'pnpm test', project_root: '/work/project', cwd: '.' },
      { job_id: 'job_1' },
      { job_id: 'job_1' },
    ]);
  });

  it('follows ordered SSE output across reconnect and then requests one terminal result', async () => {
    const jobRunRequests: unknown[] = [];
    const streamRequests: Array<{ lastEventId?: string; afterSequence?: string }> = [];
    const output: Array<{ stream: string; text: string }> = [];
    let streamConnections = 0;
    const baseUrl = await listen(
      createServer(async (req, res) => {
        if (req.url === '/internal/v1/tools/job_run') {
          jobRunRequests.push(await readJson(req));
          const response =
            jobRunRequests.length === 1
              ? { job_id: 'job_1', state: 'running', resume: true }
              : { job_id: 'job_1', state: 'completed', outcome: 'succeeded', exit_code: 0 };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }
        if (req.url?.startsWith('/internal/v1/tools/job_get')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ job: { id: 'job_1', state: 'running' } }));
          return;
        }
        if (!req.url?.startsWith('/internal/v1/jobs/job_1/logs/stream')) {
          res.writeHead(404).end();
          return;
        }
        const url = new URL(req.url, 'http://controller.invalid');
        streamConnections += 1;
        streamRequests.push({
          lastEventId:
            typeof req.headers['last-event-id'] === 'string'
              ? req.headers['last-event-id']
              : undefined,
          afterSequence: url.searchParams.get('after_sequence') ?? undefined,
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (streamConnections === 1) {
          res.end('event: log\nid: 1\ndata: {"sequence":1,"stream":"stdout","text":"one"}\n\n');
          return;
        }
        res.end(
          [
            'event: log\nid: 1\ndata: {"sequence":1,"stream":"stdout","text":"duplicate"}\n\n',
            'event: log\nid: 2\ndata: {"sequence":2,"stream":"stderr","text":"two"}\n\n',
            'event: done\ndata: {"state":"completed","last_sequence":2}\n\n',
          ].join(''),
        );
      }),
    );

    const result = await runJobToTerminal(
      baseUrl,
      { command: 'pnpm test', project_root: '/work/project', cwd: '.' },
      {
        follow: true,
        pollMs: 1,
        onChunk: (stream, text) => output.push({ stream, text }),
      },
    );

    expect(output).toEqual([
      { stream: 'stdout', text: 'one' },
      { stream: 'stderr', text: 'two' },
    ]);
    expect(streamRequests).toEqual([{}, { lastEventId: '1', afterSequence: '1' }]);
    expect(jobRunRequests).toEqual([
      { command: 'pnpm test', project_root: '/work/project', cwd: '.' },
      { job_id: 'job_1' },
    ]);
    expect(result).toEqual({
      job_id: 'job_1',
      state: 'completed',
      outcome: 'succeeded',
      exit_code: 0,
    });
  });
});
