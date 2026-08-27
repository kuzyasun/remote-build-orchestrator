import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOB_RUN_INITIAL_TIMEOUT_MS,
  JOB_RUN_WAIT_TIMEOUT_MS,
  JOB_SUBMIT_TIMEOUT_MS,
  runJobRemote,
  submitJobRemote,
} from '../src/commands/jobs.js';
import { parseRunCommandArgs, takeRunJsonFlag } from '../src/commands/run.js';

describe('rbo run parser', () => {
  it('recognizes --json only before the target-shell command separator', () => {
    expect(takeRunJsonFlag(['--json', '--', 'pnpm test'])).toEqual({
      json: true,
      args: ['--', 'pnpm test'],
    });
    expect(takeRunJsonFlag(['--', '--json'])).toEqual({
      json: false,
      args: ['--', '--json'],
    });
  });

  it('builds the shared compact job_run input without changing target-shell text', () => {
    const command = 'pnpm --filter "@rbo/controller" test && echo $HOME';
    const parsed = parseRunCommandArgs(
      [
        '--project',
        'repo',
        '--cwd',
        'apps/../apps/controller',
        '--shell',
        'bash',
        '--target-os',
        'linux',
        '--target-os',
        'macos',
        '--timeout',
        '90',
        '--risk',
        'safe',
        '--artifact',
        'coverage/**',
        '--artifact',
        'dist/*.tgz',
        '--queue-policy',
        'wait',
        '--',
        command,
      ],
      '/work',
    );

    expect(parsed.request).toEqual({
      command,
      project_root: resolve('/work', 'repo'),
      cwd: join('apps', 'controller'),
      shell: 'bash',
      target_os: ['linux', 'macos'],
      timeout_seconds: 90,
      risk_level: 'safe',
      artifacts: [
        { glob: 'coverage/**', required: false },
        { glob: 'dist/*.tgz', required: false },
      ],
      queue_policy: 'wait',
    });
  });

  it('uses a resolved current directory project and the default project cwd', () => {
    const parsed = parseRunCommandArgs(['--', 'pnpm test'], '/work/../workspace');
    expect(parsed.request).toEqual({
      command: 'pnpm test',
      project_root: resolve('/workspace'),
      cwd: '.',
    });
  });

  it.each([
    ['POSIX', 'pnpm test -- --reporter=dot'],
    ['PowerShell', 'pnpm test; Write-Output "$env:USERPROFILE"'],
    ['cmd', 'pnpm test && echo %USERPROFILE%'],
  ])('keeps the %s shell command string unchanged after local-shell quoting', (_shell, command) => {
    expect(parseRunCommandArgs(['--', command], '/work').request.command).toBe(command);
  });

  it.each([
    [[], /requires `--`/],
    [['--'], /exactly one shell-command-string/],
    [['--', 'one', 'two'], /exactly one shell-command-string/],
    [['before', '--', 'pnpm test'], /Unexpected positional/],
    [['--cwd', '../outside', '--', 'pnpm test'], /stay inside --project/],
    [['--cwd', '/absolute', '--', 'pnpm test'], /relative path inside --project/],
    [['--timeout', 'NaN', '--', 'pnpm test'], /finite number/],
  ])('rejects invalid usage: %j', (args, error) => {
    expect(() => parseRunCommandArgs(args, '/work/project')).toThrow(error);
  });

  it('forwards unvalidated compact enum values for the Controller protocol to reject', () => {
    const parsed = parseRunCommandArgs(
      ['--shell', 'fish', '--target-os', 'freebsd', '--risk', 'custom', '--', 'build'],
      '/work',
    );
    expect(parsed.request).toMatchObject({
      shell: 'fish',
      target_os: ['freebsd'],
      risk_level: 'custom',
    });
  });
});

describe('rbo run HTTP helper', () => {
  it('posts the compact input unchanged to job_run', async () => {
    let requestPath = '';
    let body: Record<string, unknown> | undefined;
    const server = createServer((req, res) => {
      requestPath = req.url ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job_id: 'job_1', resume: true }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const input = parseRunCommandArgs(
      ['--target-os', 'linux', '--artifact', 'dist/**', '--', 'pnpm test'],
      '/work/project',
    ).request;
    await expect(runJobRemote(`http://127.0.0.1:${port}`, input)).resolves.toEqual({
      job_id: 'job_1',
      resume: true,
    });
    expect(requestPath).toBe('/internal/v1/tools/job_run');
    expect(body).toEqual(input);

    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  });

  it('lets job_run and job_submit outlive the default MCP wait slice', async () => {
    const timeouts: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ((delay: number) => {
      timeouts.push(delay);
      return originalTimeout(delay);
    }) as typeof AbortSignal.timeout;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job_1', resume: true }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await runJobRemote(baseUrl, {
        command: 'pnpm test',
        project_root: '/work/project',
        cwd: '.',
      });
      await runJobRemote(baseUrl, { job_id: 'job_1' });
      await submitJobRemote(baseUrl, { command: 'pnpm test', project_root: '/work/project' });
      await runJobRemote(
        baseUrl,
        { command: 'pnpm test', project_root: '/work/project', cwd: '.' },
        { timeoutMs: 5_000 },
      );
      expect(timeouts).toEqual([
        JOB_RUN_INITIAL_TIMEOUT_MS,
        JOB_RUN_WAIT_TIMEOUT_MS,
        JOB_SUBMIT_TIMEOUT_MS,
        5_000,
      ]);
      expect(JOB_RUN_INITIAL_TIMEOUT_MS).toBeGreaterThan(55_000);
      expect(JOB_RUN_WAIT_TIMEOUT_MS).toBeGreaterThan(55_000);
    } finally {
      AbortSignal.timeout = originalTimeout;
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
      );
    }
  });
});
