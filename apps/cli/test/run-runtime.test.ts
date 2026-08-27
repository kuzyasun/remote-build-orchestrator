import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfirmationDeclinedError,
  type ConfirmationRequiredError,
  type RunInterruptedError,
  cancelAndAwaitJob,
  runJobToTerminal,
  runJobWithLifecycle,
  runLifecycleErrorExitCode,
  takeRunFollowFlag,
  terminalExitCode,
  writeRunResult,
} from '../src/commands/run-runtime.js';

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

  it('prints confirmation snapshot and warnings to stderr then confirms only from a TTY', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const baseUrl = await listen(
      createServer(async (req, res) => {
        const body = await readJson(req);
        requests.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/internal/v1/tools/job_confirm') {
          res.end(JSON.stringify({ job_id: 'job_confirmed', state: 'queued' }));
          return;
        }
        if (requests.filter((entry) => entry.path.endsWith('/job_run')).length === 1) {
          res.end(
            JSON.stringify({
              job_id: 'job_confirmed',
              state: 'awaiting_confirmation',
              confirmation_token: 'short-lived-token',
              snapshot_id: 'snp_1',
              secret_warnings: ['possible-secret.txt'],
              resume: false,
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            job_id: 'job_confirmed',
            state: 'completed',
            outcome: 'succeeded',
            exit_code: 0,
          }),
        );
      }),
    );
    const stderr: string[] = [];

    const result = await runJobWithLifecycle(
      baseUrl,
      { command: 'dangerous', project_root: '/work/project', cwd: '.' },
      {
        io: {
          isTTY: true,
          writeStderr: (text) => stderr.push(text),
          confirm: async (prompt) => prompt.includes('job_confirmed'),
        },
      },
    );

    expect(stderr.join('')).toContain('Snapshot: snp_1');
    expect(stderr.join('')).toContain('Warnings: possible-secret.txt');
    expect(requests).toEqual([
      {
        path: '/internal/v1/tools/job_run',
        body: { command: 'dangerous', project_root: '/work/project', cwd: '.' },
      },
      {
        path: '/internal/v1/tools/job_confirm',
        body: { job_id: 'job_confirmed', confirmation_token: 'short-lived-token' },
      },
      { path: '/internal/v1/tools/job_run', body: { job_id: 'job_confirmed' } },
    ]);
    expect(result).toMatchObject({ job_id: 'job_confirmed', outcome: 'succeeded', exit_code: 0 });
  });

  it('refuses a confirmation-required job without a TTY and does not bypass it', async () => {
    const baseUrl = await listen(
      createServer((req, res) => {
        expect(req.url).toBe('/internal/v1/tools/job_run');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            job_id: 'job_non_tty',
            state: 'awaiting_confirmation',
            confirmation_token: 'short-lived-token',
            snapshot_id: 'snp_2',
            secret_warnings: [],
            resume: false,
          }),
        );
      }),
    );
    const stderr: string[] = [];

    await expect(
      runJobWithLifecycle(
        baseUrl,
        { command: 'dangerous', project_root: '/work/project', cwd: '.' },
        {
          io: { isTTY: false, writeStderr: (text) => stderr.push(text), confirm: async () => true },
        },
      ),
    ).rejects.toMatchObject<Partial<ConfirmationRequiredError>>({
      category: 'confirmation_required',
      jobId: 'job_non_tty',
    });
    expect(stderr.join('')).toContain('Snapshot: snp_2');
  });

  it('keeps a declined TTY confirmation distinct from a non-interactive refusal', async () => {
    const baseUrl = await listen(
      createServer((req, res) => {
        expect(req.url).toBe('/internal/v1/tools/job_run');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            job_id: 'job_declined',
            state: 'awaiting_confirmation',
            confirmation_token: 'short-lived-token',
            snapshot_id: 'snp_3',
            secret_warnings: [],
            resume: false,
          }),
        );
      }),
    );

    await expect(
      runJobWithLifecycle(
        baseUrl,
        { command: 'dangerous', project_root: '/work/project', cwd: '.' },
        { io: { isTTY: true, writeStderr: () => undefined, confirm: async () => false } },
      ),
    ).rejects.toMatchObject<Partial<ConfirmationDeclinedError>>({ jobId: 'job_declined' });
    expect(runLifecycleErrorExitCode(new ConfirmationDeclinedError('job_declined'))).toBe(1);
  });

  it('turns an interrupted confirmation prompt into cancellation with its known job ID', async () => {
    const controller = new AbortController();
    const baseUrl = await listen(
      createServer((req, res) => {
        expect(req.url).toBe('/internal/v1/tools/job_run');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            job_id: 'job_prompt_interrupt',
            state: 'awaiting_confirmation',
            confirmation_token: 'short-lived-token',
            snapshot_id: 'snp_4',
            secret_warnings: [],
            resume: false,
          }),
        );
      }),
    );

    await expect(
      runJobWithLifecycle(
        baseUrl,
        { command: 'dangerous', project_root: '/work/project', cwd: '.' },
        {
          signal: controller.signal,
          io: {
            isTTY: true,
            writeStderr: () => undefined,
            confirm: async (_prompt, signal) =>
              new Promise<boolean>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('prompt aborted')), {
                  once: true,
                });
                controller.abort();
              }),
          },
        },
      ),
    ).rejects.toMatchObject<Partial<RunInterruptedError>>({ jobId: 'job_prompt_interrupt' });
  });

  it('forwards cancellation once and observes the terminal cancelled state', async () => {
    const requests: string[] = [];
    const baseUrl = await listen(
      createServer(async (req, res) => {
        requests.push(req.url ?? '');
        if (req.url === '/internal/v1/tools/job_get') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ job: { state: 'completed', outcome: 'cancelled', exit_code: null } }),
          );
          return;
        }
        await readJson(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job_id: 'job_cancelled', cancel_requested: true }));
      }),
    );
    const stderr: string[] = [];

    await expect(
      cancelAndAwaitJob(baseUrl, 'job_cancelled', {
        // Local HTTP startup and one fetch round trip can exceed a few tens of
        // milliseconds under parallel verification load. This is a success-path
        // protocol assertion, not a deadline test.
        confirmationMs: 1_000,
        pollMs: 1,
        writeStderr: (text) => stderr.push(text),
      }),
    ).resolves.toBe(true);
    expect(requests).toEqual(['/internal/v1/tools/job_cancel', '/internal/v1/tools/job_get']);
    expect(stderr).toEqual([]);
  });

  it('warns with the job ID when cancellation is not confirmed within the fixed window', async () => {
    const baseUrl = await listen(
      createServer(async (req, res) => {
        await readJson(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/internal/v1/tools/job_get') {
          res.end(JSON.stringify({ job: { state: 'running', outcome: null, exit_code: null } }));
          return;
        }
        res.end(JSON.stringify({ job_id: 'job_still_stopping', cancel_requested: true }));
      }),
    );
    const stderr: string[] = [];

    await expect(
      cancelAndAwaitJob(baseUrl, 'job_still_stopping', {
        confirmationMs: 20,
        pollMs: 1,
        writeStderr: (text) => stderr.push(text),
      }),
    ).resolves.toBe(false);

    expect(stderr.join('')).toContain('job_still_stopping');
    expect(stderr.join('')).toContain('not confirmed within 10 seconds');
  });

  it('stops terminal waiting when interrupted after a job ID is available', async () => {
    const controller = new AbortController();
    const baseUrl = await listen(
      createServer(async (req, res) => {
        await readJson(req);
        controller.abort();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job_id: 'job_interrupted', state: 'running', resume: true }));
      }),
    );

    await expect(
      runJobToTerminal(
        baseUrl,
        { command: 'pnpm test', project_root: '/work/project', cwd: '.' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject<Partial<RunInterruptedError>>({ jobId: 'job_interrupted' });
  });

  it('aborts an in-flight job_run resume request when Ctrl+C arrives after the job ID', async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const baseUrl = await listen(
      createServer(async (req, res) => {
        await readJson(req);
        requestCount += 1;
        if (requestCount === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ job_id: 'job_abort_request', state: 'running', resume: true }));
          return;
        }
        controller.abort();
        // Keep the response pending: the client must stop via its abort signal, not the wait timeout.
      }),
    );

    await expect(
      runJobToTerminal(
        baseUrl,
        { command: 'pnpm test', project_root: '/work/project', cwd: '.' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject<Partial<RunInterruptedError>>({ jobId: 'job_abort_request' });
  });

  it('aborts the first wait when the compact input already has a job ID', async () => {
    const controller = new AbortController();
    const baseUrl = await listen(
      createServer(async (req, res) => {
        await readJson(req);
        controller.abort();
        // Keep the response pending: job_id is already known, so this wait must be cancellable.
      }),
    );

    await expect(
      runJobToTerminal(baseUrl, { job_id: 'job_known' }, { signal: controller.signal }),
    ).rejects.toMatchObject<Partial<RunInterruptedError>>({ jobId: 'job_known' });
  }, 5_000);

  it.each([
    [{ outcome: 'succeeded', exit_code: 0 }, 0],
    [{ outcome: 'failed', exit_code: 1 }, 1],
    [{ outcome: 'failed', exit_code: 255 }, 255],
    [{ outcome: 'failed', exit_code: 256 }, 125],
    [{ outcome: 'failed', exit_code: 'bad' }, 125],
    [{ outcome: 'timed_out', exit_code: null }, 124],
    [{ outcome: 'failed', exit_code: null, failure_category: 'timeout' }, 124],
    [{ outcome: 'cancelled', exit_code: null }, 130],
    [{ outcome: 'failed', exit_code: null, failure_category: 'cancelled' }, 130],
    [{ outcome: 'failed', exit_code: null }, 1],
  ])('maps terminal result %# to exit status %i', (result, expected) => {
    expect(terminalExitCode(result)).toBe(expected);
  });

  it('writes exactly one terminal JSON document to stdout and diagnostics only to stderr', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = { job_id: 'job_json', outcome: 'succeeded', exit_code: 0 };

    writeRunResult(result, {
      json: true,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });

    expect(stdout).toEqual([`${JSON.stringify(result)}\n`]);
    expect(stderr).toEqual([]);
  });

  it('writes non-JSON terminal reporting to stderr to preserve stdout for job output', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    writeRunResult(
      { job_id: 'job_human', outcome: 'succeeded', exit_code: 0 },
      {
        json: false,
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
      },
    );

    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('job_human');
  });
});
