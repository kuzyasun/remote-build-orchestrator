import * as executor from '@rbo/executor';
import { JOB_RUN_INPUT } from '@rbo/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildJobRunRequest, handleJobRun, wrapCommandAsExecution } from '../src/jobs/job-run.js';
import * as lifecycle from '../src/jobs/lifecycle.js';
import * as submit from '../src/jobs/submit.js';
import * as pagination from '../src/mcp/log-pagination.js';

vi.mock('../src/jobs/submit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    waitForJob: vi.fn(),
    handleJobSubmit: vi.fn(),
    handleJobArtifacts: vi.fn(),
  };
});
vi.mock('../src/jobs/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    getJob: vi.fn(),
    isTerminalJobState: (state: string) => state === 'completed' || state === 'failed',
    getLatestAttempt: vi.fn(),
  };
});
vi.mock('../src/mcp/log-pagination.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    readJobLogsPage: vi.fn(),
    readIndexedRange: vi.fn(),
    decodeCursor: vi.fn(),
    encodeCursor: vi.fn(),
  };
});
vi.mock('@rbo/executor', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    presentLogChunks: vi.fn(),
    readChunkIndexTail: vi.fn(),
  };
});

describe('wrapCommandAsExecution', () => {
  it('wraps Windows commands with PowerShell fail-closed exit handling', () => {
    const exec = wrapCommandAsExecution('eim run "idf.py build"', 120, 'win32');
    expect(exec.shell).toBe('powershell');
    expect(exec.timeout_seconds).toBe(120);
    expect(exec.script).toContain("$ErrorActionPreference = 'Stop'");
    expect(exec.script).toContain('eim run "idf.py build"');
    expect(exec.script).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  });

  it('wraps Unix commands with bash set -euo pipefail', () => {
    const exec = wrapCommandAsExecution('make test', 60, 'linux');
    expect(exec.shell).toBe('bash');
    expect(exec.timeout_seconds).toBe(60);
    expect(exec.script).toBe('set -euo pipefail\nmake test\n');
  });

  it.each([
    ['bash', 'set -euo pipefail\nmake test\n'],
    ['zsh', 'set -euo pipefail\nmake test\n'],
    ['sh', 'set -eu\nmake test\n'],
    [
      'powershell',
      "$ErrorActionPreference = 'Stop'\nmake test\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ],
    [
      'pwsh',
      "$ErrorActionPreference = 'Stop'\nmake test\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ],
    ['cmd', '@echo off\r\nmake test\r\nif errorlevel 1 exit /b %errorlevel%'],
  ] as const)('wraps explicit %s commands without translating their syntax', (shell, script) => {
    const exec = wrapCommandAsExecution('make test', 60, 'linux', shell);
    expect(exec).toEqual({ shell, script, timeout_seconds: 60 });
  });

  it('uses the legacy direct script wrapper for each platform', () => {
    expect(wrapCommandAsExecution('build.cmd', 60, 'win32', 'direct')).toEqual({
      shell: 'direct',
      script: '@echo off\r\nbuild.cmd\r\nif errorlevel 1 exit /b %errorlevel%',
      timeout_seconds: 60,
    });
    expect(wrapCommandAsExecution('./build', 60, 'linux', 'direct')).toEqual({
      shell: 'direct',
      script: '#!/usr/bin/env bash\nset -euo pipefail\n./build\n',
      timeout_seconds: 60,
    });
  });
});

describe('buildJobRunRequest', () => {
  it('builds a JobRequest with defaults and derived name', () => {
    const request = buildJobRunRequest(
      {
        command: 'echo hello',
        project_root: 'C:/projects/app',
        artifacts: [{ glob: 'out.txt', required: true }],
      },
      'win32',
    );
    expect(request.source.project_root).toBe('C:/projects/app');
    expect(request.source.cwd).toBe('.');
    expect(request.risk_level).toBe('normal');
    expect(request.name).toBe('echo hello');
    expect(request.client_request_id).toMatch(/^req_/);
    expect(request.execution.shell).toBe('powershell');
    expect(request.artifacts).toEqual([{ glob: 'out.txt', required: true }]);
  });

  it('honours explicit name, cwd, risk_level, and client_request_id', () => {
    const request = buildJobRunRequest(
      {
        command: 'npm test',
        project_root: '/tmp/app',
        cwd: 'packages/core',
        name: 'unit',
        risk_level: 'safe',
        client_request_id: 'req_custom',
        timeout_seconds: 90,
      },
      'linux',
    );
    expect(request.name).toBe('unit');
    expect(request.source.cwd).toBe('packages/core');
    expect(request.risk_level).toBe('safe');
    expect(request.client_request_id).toBe('req_custom');
    expect(request.execution.timeout_seconds).toBe(90);
    expect(request.execution.shell).toBe('bash');
  });

  it('maps explicit cross-platform shell and OS constraints into the canonical request', () => {
    const request = buildJobRunRequest(
      {
        command: 'Write-Output done',
        project_root: '/tmp/app',
        shell: 'pwsh',
        target_os: ['windows'],
      },
      'linux',
    );
    expect(request.execution).toMatchObject({
      shell: 'pwsh',
      script: expect.stringContaining('Write-Output done'),
    });
    expect(request.requirements).toEqual({ os: ['windows'] });
  });

  it.each(['local_fallback', 'wait', 'fail_fast'] as const)(
    'maps explicit queue_policy=%s into the canonical request',
    (queue_policy) => {
      const request = buildJobRunRequest(
        {
          command: 'echo policy',
          project_root: '/tmp/app',
          queue_policy,
        },
        'linux',
      );

      expect(request.queue_policy).toBe(queue_policy);
    },
  );

  it('leaves an omitted queue_policy undefined for Controller default normalization', () => {
    const request = buildJobRunRequest(
      {
        command: 'echo default policy',
        project_root: '/tmp/app',
      },
      'linux',
    );

    expect(request.queue_policy).toBeUndefined();
  });

  it('uses a single explicit target OS to wrap legacy direct scripts safely', () => {
    const windowsRequest = buildJobRunRequest(
      {
        command: 'build.cmd',
        project_root: '/tmp/app',
        shell: 'direct',
        target_os: ['windows'],
      },
      'linux',
    );
    expect(windowsRequest.execution).toMatchObject({
      shell: 'direct',
      script: '@echo off\r\nbuild.cmd\r\nif errorlevel 1 exit /b %errorlevel%',
    });
    const posixRequest = buildJobRunRequest(
      {
        command: './build',
        project_root: 'C:/app',
        shell: 'direct',
        target_os: ['linux'],
      },
      'win32',
    );
    expect(posixRequest.execution).toMatchObject({
      shell: 'direct',
      script: '#!/usr/bin/env bash\nset -euo pipefail\n./build\n',
    });
  });

  it.each([undefined, ['windows', 'linux'], ['freebsd']])(
    'rejects legacy direct scripts without exactly one canonical target OS: %j',
    (target_os) => {
      expect(() =>
        buildJobRunRequest(
          {
            command: 'build',
            project_root: '/tmp/app',
            shell: 'direct',
            target_os,
          },
          'linux',
        ),
      ).toThrow(/shell=direct requires exactly one canonical target_os/);
    },
  );

  it('rejects build without command/project_root', () => {
    expect(() => buildJobRunRequest({ command: 'echo hi' }, 'linux')).toThrow(/project_root/);
  });
});

describe('JOB_RUN_INPUT validation', () => {
  const schema = z.object(JOB_RUN_INPUT).strict();
  it('max_output_bytes min=4 validation', () => {
    const base = { command: 'echo 1', project_root: 'foo' };
    expect(schema.safeParse({ ...base, max_output_bytes: 3 }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_output_bytes: 4 }).success).toBe(true);
    expect(schema.safeParse({ ...base, max_output_bytes: 1024 * 1024 }).success).toBe(true);
  });

  it('accepts canonical explicit shell and target OS values, rejecting invalid values', () => {
    const base = { command: 'echo 1', project_root: 'foo' };
    expect(schema.safeParse({ ...base, shell: 'pwsh', target_os: ['windows'] }).success).toBe(true);
    expect(schema.safeParse({ ...base, shell: 'fish' }).success).toBe(false);
    expect(schema.safeParse({ ...base, target_os: ['freebsd'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, target_os: [] }).success).toBe(false);
  });

  it.each(['local_fallback', 'wait', 'fail_fast'] as const)(
    'accepts canonical queue_policy=%s',
    (queue_policy) => {
      expect(
        schema.safeParse({ command: 'echo 1', project_root: 'foo', queue_policy }).success,
      ).toBe(true);
    },
  );

  it('rejects a non-canonical queue_policy', () => {
    expect(
      schema.safeParse({ command: 'echo 1', project_root: 'foo', queue_policy: 'queue_forever' })
        .success,
    ).toBe(false);
  });
});

describe('handleJobRun responses', () => {
  const db = {} as Record<string, unknown>;
  const ctx = { db, dataDir: '/data', controllerIdentity: {} as Record<string, unknown> };
  const testCtx = ctx as unknown as Parameters<typeof handleJobRun>[0];
  const rawInput = { job_id: 'job-1', max_output_bytes: 1024 };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: { state: 'running' } });
    vi.mocked(submit.handleJobArtifacts).mockReturnValue({ artifacts: [] });
    // biome-ignore lint/suspicious/noExplicitAny: mock partial JobRow
    vi.mocked(lifecycle.getJob).mockReturnValue({ state: 'running' } as any);
  });

  it('Sparse success (no null/empty fields, <=2 KiB serialized)', async () => {
    const jobRow = { state: 'completed', outcome: 'succeeded', exit_code: 0 };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, rawInput);

    expect(res).toEqual({
      job_id: 'job-1',
      state: 'completed',
      outcome: 'succeeded',
      exit_code: 0,
    });
    expect(JSON.stringify(res).length).toBeLessThan(2048);
  });

  it('Failure with diagnostic_excerpt (bounded by max_output_bytes)', async () => {
    const jobRow = { state: 'failed', outcome: 'failed', exit_code: 1, failure_category: 'test' };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    // biome-ignore lint/suspicious/noExplicitAny: mock partial AttemptRow
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue({ id: 'att-1' } as any);

    vi.mocked(executor.readChunkIndexTail).mockResolvedValue([
      { stream: 'stderr', byte_length: 10, sequence: 1, byte_offset: 0 },
    ]);
    vi.mocked(pagination.readIndexedRange).mockResolvedValue(Buffer.from('failed log'));
    vi.mocked(executor.presentLogChunks).mockReturnValue({
      data: Buffer.from('failed log'),
      // biome-ignore lint/suspicious/noExplicitAny: mock partial LogPresentationState
      state: {} as any,
      consumedRawBytes: 10,
      scannedRawBytes: 10,
      truncated: false,
    });

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, rawInput);
    expect(res).toMatchObject({
      job_id: 'job-1',
      state: 'failed',
      outcome: 'failed',
      exit_code: 1,
      failure_category: 'test',
      diagnostic_excerpt: 'failed log',
    });
  });

  it('returns the persisted no-match diagnostic without Agent details', async () => {
    const jobRow = {
      state: 'failed',
      outcome: 'failed',
      exit_code: null,
      failure_category: 'no_matching_agent',
      failure_message: 'No online Agent provides bash on windows.',
      result_json: JSON.stringify({
        no_match: {
          category: 'no_matching_agent',
          retryable: false,
          required_shell: 'bash',
          target_os: ['windows'],
          hint: 'No online Agent provides bash on windows.',
        },
      }),
    };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue(undefined);

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, rawInput);

    expect(res.no_match).toEqual({
      category: 'no_matching_agent',
      retryable: false,
      required_shell: 'bash',
      target_os: ['windows'],
      hint: 'No online Agent provides bash on windows.',
    });
    expect(JSON.stringify(res.no_match)).not.toContain('private/agent-hostname');
  });

  it.each([
    ['a successful job', { state: 'completed', outcome: 'succeeded', exit_code: 0 }],
    [
      'an unrelated failed job',
      { state: 'failed', outcome: 'failed', exit_code: 1, failure_category: 'process_exit' },
    ],
  ])('does not expose no_match for %s', async (_label, jobState) => {
    const result_json = JSON.stringify({
      no_match: {
        category: 'no_matching_agent',
        retryable: false,
        required_shell: 'bash',
        target_os: ['linux'],
        hint: 'No online Agent provides bash on linux.',
      },
    });
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: { ...jobState, result_json } });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue(undefined);

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, rawInput);

    expect(res.no_match).toBeUndefined();
  });

  it.each([
    ['required_shell', { required_shell: 'x'.repeat(17) }],
    ['target_os entry', { target_os: ['linux', 'windows', 'macos', 'freebsd'] }],
    ['hint', { hint: 'x'.repeat(257) }],
  ])('omits malformed overlong no_match %s', async (_label, override) => {
    const result_json = JSON.stringify({
      no_match: {
        category: 'no_matching_agent',
        retryable: false,
        required_shell: 'bash',
        target_os: ['linux'],
        hint: 'No online Agent provides bash on linux.',
        ...override,
      },
    });
    vi.mocked(submit.waitForJob).mockResolvedValue({
      job: {
        state: 'failed',
        outcome: 'failed',
        exit_code: null,
        failure_category: 'no_matching_agent',
        result_json,
      },
    });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue(undefined);

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, rawInput);

    expect(res.no_match).toBeUndefined();
  });

  it('Non-terminal resume with log_chunks and next_log_cursor', async () => {
    const jobRow = { state: 'running' };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    // biome-ignore lint/suspicious/noExplicitAny: mock partial AttemptRow
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue({ id: 'att-1' } as any);

    vi.mocked(pagination.readJobLogsPage).mockResolvedValue({
      chunks: [{ sequence: 1, stream: 'stdout', text: 'hi', complete: true }],
      // biome-ignore lint/suspicious/noExplicitAny: mock partial LogCursor
      next: { v: 1 } as any,
      returned: 2,
      hasMore: false,
      truncated: false,
    });
    vi.mocked(pagination.encodeCursor).mockReturnValue('encoded_cursor');

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, rawInput);
    expect(res).toMatchObject({
      job_id: 'job-1',
      state: 'running',
      resume: true,
      log_chunks: [{ sequence: 1, stream: 'stdout', text: 'hi', complete: true }],
      next_log_cursor: 'encoded_cursor',
      returned_bytes: 2,
    });
  });

  it('Input log_cursor passed through on no-progress', async () => {
    const jobRow = { state: 'completed', outcome: 'succeeded', exit_code: 0 };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    vi.mocked(pagination.decodeCursor).mockReturnValue({
      v: 1,
      job: 'job-1',
      attempt: 'att-1',
      mode: 'logs',
      seq: 0,
      off: 0,
      profile: 'ansi-v1',
    });

    // biome-ignore lint/suspicious/noExplicitAny: partial SubmitJobContext mock
    const res = await handleJobRun(ctx as any, { job_id: 'job-1', log_cursor: 'old_cursor' });
    expect(res).toMatchObject({
      job_id: 'job-1',
      next_log_cursor: 'old_cursor',
    });
  });

  it('Rejects malformed or stale log cursors instead of replaying from zero', async () => {
    const jobRow = { state: 'running' };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue({
      id: 'att-2',
    } as unknown as lifecycle.AttemptRow);
    vi.mocked(pagination.decodeCursor).mockReturnValue({
      v: 1,
      job: 'job-1',
      attempt: 'att-1',
      mode: 'logs',
      seq: 0,
      off: 0,
      profile: 'ansi-v1',
    });

    const res = await handleJobRun(testCtx, { job_id: 'job-1', log_cursor: 'stale' });
    expect(res).toEqual({
      error: {
        category: 'validation',
        message: 'Cursor does not match job, attempt, or mode',
        retryable: false,
      },
    });
    expect(pagination.readJobLogsPage).not.toHaveBeenCalled();
  });

  it('Rejects malformed cursors on terminal responses', async () => {
    vi.mocked(submit.waitForJob).mockResolvedValue({
      job: { state: 'completed', outcome: 'succeeded', exit_code: 0 },
    });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue({
      id: 'att-1',
    } as unknown as lifecycle.AttemptRow);
    vi.mocked(pagination.decodeCursor).mockReturnValue(null);

    const res = await handleJobRun(testCtx, { job_id: 'job-1', log_cursor: 'malformed' });
    expect(res).toMatchObject({ error: { category: 'validation', retryable: false } });
    expect(pagination.readJobLogsPage).not.toHaveBeenCalled();
  });

  it('Advances over a control-only page and errors when the cursor cannot be encoded', async () => {
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: { state: 'running' } });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue({
      id: 'att-1',
    } as unknown as lifecycle.AttemptRow);
    vi.mocked(pagination.readJobLogsPage).mockResolvedValue({
      chunks: [],
      next: {
        v: 1,
        job: 'job-1',
        attempt: 'att-1',
        mode: 'logs',
        seq: 2,
        off: 0,
        profile: 'ansi-v1',
      },
      returned: 0,
      hasMore: false,
      truncated: false,
    });
    vi.mocked(pagination.encodeCursor).mockReturnValue(null);

    const res = await handleJobRun(testCtx, { job_id: 'job-1', max_output_bytes: 4 });
    expect(res).toEqual({
      error: { category: 'internal', message: 'Unable to encode log cursor', retryable: true },
    });
  });

  it('Bounds diagnostic index window and artifact metadata', async () => {
    const jobRow = { state: 'failed', outcome: 'failed', exit_code: 1 };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue({
      id: 'att-1',
    } as unknown as lifecycle.AttemptRow);
    vi.mocked(submit.handleJobArtifacts).mockReturnValue({
      artifacts: [
        { path: 'old', detail: 'x'.repeat(9000) },
        { path: 'new', size: 100 },
      ],
    });
    vi.mocked(executor.readChunkIndexTail).mockResolvedValue([
      { stream: 'stderr', byte_length: 100, sequence: 1, byte_offset: 0 },
      { stream: 'stderr', byte_length: 100, sequence: 2, byte_offset: 100 },
    ]);
    vi.mocked(pagination.readIndexedRange).mockImplementation(async (_logs, entry) =>
      entry.sequence === 2 ? Buffer.from('newest') : Buffer.from('old'),
    );
    vi.mocked(executor.presentLogChunks).mockImplementation(([bytes]) => ({
      data: bytes,
      state: {} as executor.LogPresentationState,
      consumedRawBytes: bytes.length,
      scannedRawBytes: bytes.length,
      truncated: false,
    }));

    const res = await handleJobRun(testCtx, { job_id: 'job-1', max_output_bytes: 4 });
    expect(res.diagnostic_excerpt).toBe('west');
    expect(pagination.readIndexedRange).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ artifact_count: 2, artifacts_truncated: true });
    expect(JSON.stringify(res).length).toBeLessThan(1024);
  });

  it('Caps successful artifact metadata to the compact response budget', async () => {
    const jobRow = { state: 'completed', outcome: 'succeeded', exit_code: 0 };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    vi.mocked(submit.handleJobArtifacts).mockReturnValue({
      artifacts: [{ path: 'large', detail: 'x'.repeat(9000) }],
    });

    const res = await handleJobRun(testCtx, { job_id: 'job-1' });
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(2048);
    expect(res).toMatchObject({ artifact_count: 1, artifacts_truncated: true });
  });

  it('Bounds failure metadata and preserves UTF-8 boundaries', async () => {
    const jobRow = {
      state: 'failed',
      outcome: 'failed',
      exit_code: 1,
      failure_category: 'é'.repeat(5000),
      failure_message: '界'.repeat(5000),
    };
    vi.mocked(submit.waitForJob).mockResolvedValue({ job: jobRow });
    vi.mocked(lifecycle.getLatestAttempt).mockReturnValue(undefined);
    vi.mocked(submit.handleJobArtifacts).mockReturnValue({ artifacts: [] });

    const res = await handleJobRun(testCtx, { job_id: 'job-1', max_output_bytes: 4 });
    const { diagnostic_excerpt: _diagnosticExcerpt, ...metadata } = res;
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(8192);
    expect(res.failure_category).not.toContain('\ufffd');
    expect(res.failure_message).not.toContain('\ufffd');
  });
});
