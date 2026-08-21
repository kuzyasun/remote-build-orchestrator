import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JobRequest } from '@rbo/protocol';
import { ensureControllerIdentity } from '@rbo/shared';
import { assertGitStateUnchanged, captureGitState } from '@rbo/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptArtifactsDir,
  attemptLogDir,
  attemptWorkspaceDir,
} from '../src/execution/runner.js';
import { startControllerServer } from '../src/http/server.js';
import type { RunningControllerServer } from '../src/http/server.js';
import { getJobRequest, getLatestAttempt } from '../src/jobs/lifecycle.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function createFixtureRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rbo-job-'));
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (!first || first.type !== 'text') {
    throw new Error('expected text content');
  }
  return first.text;
}

function baseJobRequest(projectRoot: string): JobRequest {
  const script =
    process.platform === 'win32'
      ? 'Write-Output "hello"; Set-Content -Path out.txt -Value "artifact-data"'
      : 'echo hello\nprintf artifact-data > out.txt';
  return {
    client_request_id: `req-${Date.now()}`,
    name: 'phase3-test',
    source: { project_root: projectRoot, cwd: '.' },
    execution: {
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      script,
      timeout_seconds: 30,
      cancel_grace_seconds: 1,
    },
    risk_level: 'safe',
    artifacts: [{ glob: 'out.txt', required: true }],
  };
}

let running: RunningControllerServer;
let dataDir: string;
let db: ControllerDatabase;
let fixtureDir: string;
let artifactDestRoot: string;
let cleanupFixture: () => Promise<void>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rbo-controller-job-'));
  artifactDestRoot = await mkdtemp(join(tmpdir(), 'rbo-artifact-dest-'));
  db = openDatabase(':memory:');
  migrateToLatest(db);
  const identity = await ensureControllerIdentity(dataDir);
  const fixture = await createFixtureRepo();
  fixtureDir = fixture.dir;
  cleanupFixture = fixture.cleanup;
  await writeFile(join(fixtureDir, 'tracked.txt'), 'tracked');
  await runGit(fixtureDir, ['add', 'tracked.txt']);
  await runGit(fixtureDir, ['commit', '-m', 'init']);

  running = await startControllerServer({
    // These fixtures use local repos with no allowlisted remote, so overlay
    // capture is impossible; opt in to the full-snapshot path explicitly.
    allowFullSnapshotFallback: true,
    host: '127.0.0.1',
    port: 0,
    db,
    identity,
    dataDir,
    allowedProjectRoots: [fixtureDir],
    allowedArtifactDestinations: [artifactDestRoot],
    maxConcurrentJobs: 1,
  });
});

afterAll(async () => {
  await running.close();
  await new Promise((r) => setTimeout(r, 500));
  await cleanupFixture();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(artifactDestRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 120_000);

async function connectClient(clientId: string): Promise<Client> {
  const client = new Client({ name: 'test-job-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${running.port}/mcp`),
    { requestInit: { headers: { 'x-rbo-client-id': clientId } } },
  );
  await client.connect(transport);
  return client;
}

describe('Local job execution', () => {
  it('runs a command via job_run and returns outcome + artifacts', async () => {
    const client = await connectClient('client-job-run');
    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    const targetOs =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const command =
      process.platform === 'win32'
        ? 'Write-Output "hello"; Set-Content -Path out.txt -Value "artifact-data"'
        : 'echo hello && printf artifact-data > out.txt';
    const result = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_run',
          arguments: {
            command,
            project_root: fixtureDir,
            shell,
            target_os: [targetOs],
            client_request_id: `job-run-${Date.now()}`,
            timeout_seconds: 60,
            artifacts: [{ glob: 'out.txt', required: true }],
            risk_level: 'safe',
          },
        }),
      ),
    );
    expect(result.job_id).toMatch(/^job_/);
    expect(result.state).toBe('completed');
    expect(result.outcome).toBe('succeeded');
    expect(result.exit_code).toBe(0);
    expect(getJobRequest(db, result.job_id)).toMatchObject({
      execution: { shell },
      requirements: { os: [targetOs] },
    });
    // P-02 sparse success: terminal responses omit resume field
    expect(result.resume).toBeUndefined();
    // Artifacts are only present when non-empty
    expect(result.artifacts?.length ?? 0).toBeGreaterThan(0);
    await client.close();
  }, 120_000);

  it('returns resume:true when mcp wait slice expires before the job finishes', async () => {
    const client = await connectClient('client-job-run-slice');
    const command =
      process.platform === 'win32'
        ? 'Start-Sleep -Seconds 8; Write-Output done'
        : 'sleep 8; echo done';
    const first = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_run',
          arguments: {
            command,
            project_root: fixtureDir,
            client_request_id: `job-run-slice-${Date.now()}`,
            timeout_seconds: 60,
            mcp_wait_slice_seconds: 2,
            risk_level: 'safe',
          },
        }),
      ),
    );
    expect(first.job_id).toMatch(/^job_/);
    expect(first.resume).toBe(true);
    expect(first.state).not.toBe('completed');

    // Resume until terminal (a few short slices).
    let final = first;
    for (let i = 0; i < 10 && final.resume === true; i++) {
      final = JSON.parse(
        textOf(
          await client.callTool({
            name: 'job_run',
            arguments: {
              job_id: first.job_id,
              mcp_wait_slice_seconds: 5,
              max_output_bytes: 4096,
            },
          }),
        ),
      );
    }
    // P-02 sparse success: terminal responses omit resume field
    expect(final.resume).toBeUndefined();
    expect(final.state).toBe('completed');
    expect(final.outcome).toBe('succeeded');
    await client.close();
  }, 120_000);

  it('returns awaiting_confirmation from job_run without waiting', async () => {
    const client = await connectClient('client-job-run-destructive');
    const result = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_run',
          arguments: {
            command: process.platform === 'win32' ? 'Write-Output ok' : 'echo ok',
            project_root: fixtureDir,
            client_request_id: `job-run-dest-${Date.now()}`,
            risk_level: 'destructive',
            timeout_seconds: 30,
          },
        }),
      ),
    );
    expect(result.state).toBe('awaiting_confirmation');
    expect(result.confirmation_token).toBeTruthy();
    expect(result.resume).toBe(false);
    expect(result.outcome).toBeNull();
    expect(result.artifacts).toEqual([]);
    const resumed = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_run',
          arguments: { job_id: result.job_id },
        }),
      ),
    );
    expect(resumed.state).toBe('awaiting_confirmation');
    expect(resumed.confirmation_required).toBe(true);
    expect(resumed.confirmation_token).toBe(result.confirmation_token);
    expect(resumed.snapshot_id).toBe(result.snapshot_id);
    expect(resumed.content_id).toBe(result.content_id);
    await client.close();
  }, 60_000);

  it('submits a safe job, waits for completion, and collects artifacts', async () => {
    const client = await connectClient('client-a');
    const request = baseJobRequest(fixtureDir);
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    expect(submit.job_id).toMatch(/^job_/);
    expect(submit.snapshot_captured).toBe(true);

    const waited = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_wait',
          arguments: { job_id: submit.job_id, wait_seconds: 60, include_log_tail_lines: 5 },
        }),
      ),
    );
    expect(waited.job.state).toBe('completed');
    expect(waited.job.outcome).toBe('succeeded');
    expect(waited.log_tail).toEqual(expect.any(String));

    const artifacts = JSON.parse(
      textOf(
        await client.callTool({ name: 'job_artifacts', arguments: { job_id: submit.job_id } }),
      ),
    );
    expect(artifacts.artifacts.length).toBeGreaterThan(0);
    await client.close();
  }, 120_000);

  it('does not mutate source git state after job execution', async () => {
    const before = await captureGitState(fixtureDir);
    const client = await connectClient('client-git');
    const request = { ...baseJobRequest(fixtureDir), client_request_id: `git-${Date.now()}` };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    await client.callTool({
      name: 'job_wait',
      arguments: { job_id: submit.job_id, wait_seconds: 60 },
    });
    const after = await captureGitState(fixtureDir);
    assertGitStateUnchanged(before, after);
    await client.close();
  }, 120_000);

  it('requires confirmation for destructive jobs', async () => {
    const client = await connectClient('client-destructive');
    const request = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `destructive-${Date.now()}`,
      risk_level: 'destructive' as const,
    };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    expect(submit.state).toBe('awaiting_confirmation');
    expect(submit.confirmation_token).toBeTruthy();

    const premature = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_wait',
          arguments: { job_id: submit.job_id, wait_seconds: 2 },
        }),
      ),
    );
    expect(premature.job.state).toBe('awaiting_confirmation');

    const confirmed = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_confirm',
          arguments: {
            job_id: submit.job_id,
            confirmation_token: submit.confirmation_token,
          },
        }),
      ),
    );
    expect(confirmed.state).toBe('queued');
    await client.close();
  }, 120_000);

  it('isolates artifact materialization to allowed destinations', async () => {
    const client = await connectClient('client-artifact');
    const request = { ...baseJobRequest(fixtureDir), client_request_id: `art-${Date.now()}` };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    await client.callTool({
      name: 'job_wait',
      arguments: { job_id: submit.job_id, wait_seconds: 60 },
    });
    const artifacts = JSON.parse(
      textOf(
        await client.callTool({ name: 'job_artifacts', arguments: { job_id: submit.job_id } }),
      ),
    );
    const artifactId = artifacts.artifacts[0]?.id;
    expect(artifactId).toBeTruthy();

    const outside = JSON.parse(
      textOf(
        await client.callTool({
          name: 'artifact_materialize',
          arguments: {
            artifact_id: artifactId,
            destination_path: join(tmpdir(), 'outside-rbo', 'leak.txt'),
            overwrite: false,
          },
        }),
      ),
    );
    expect(outside.error).toBeTruthy();

    const destPath = join(artifactDestRoot, 'materialized-out.txt');
    const ok = JSON.parse(
      textOf(
        await client.callTool({
          name: 'artifact_materialize',
          arguments: {
            artifact_id: artifactId,
            destination_path: destPath,
            overwrite: false,
          },
        }),
      ),
    );
    expect(ok.destination_path).toBe(destPath);
    expect((await readFile(destPath, 'utf8')).trim()).toBe('artifact-data');
    await client.close();
  }, 120_000);

  it('does not conflict across different client_ids with the same client_request_id', async () => {
    const sharedRequestId = `shared-${Date.now()}`;
    const clientA = await connectClient('client-a-idem');
    const clientB = await connectClient('client-b-idem');
    const requestA = { ...baseJobRequest(fixtureDir), client_request_id: sharedRequestId };
    const requestB = { ...baseJobRequest(fixtureDir), client_request_id: sharedRequestId };

    const submitA = JSON.parse(
      textOf(await clientA.callTool({ name: 'job_submit', arguments: requestA })),
    );
    const submitB = JSON.parse(
      textOf(await clientB.callTool({ name: 'job_submit', arguments: requestB })),
    );
    expect(submitA.job_id).toBeTruthy();
    expect(submitB.job_id).toBeTruthy();
    expect(submitA.job_id).not.toBe(submitB.job_id);
    await clientA.close();
    await clientB.close();
  });

  it('does not create a job row when snapshot capture fails', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'rbo-outside-'));
    const client = await connectClient('client-capture-fail');
    const request = {
      ...baseJobRequest(outsideRoot),
      client_request_id: `capture-fail-${Date.now()}`,
    };

    const jobsBefore = (db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number })
      .count;

    const response = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    expect(response.error).toBeTruthy();
    expect(response.job_id).toBeUndefined();

    const jobsAfter = (db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number })
      .count;
    expect(jobsAfter).toBe(jobsBefore);
    await client.close();
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('isolates workspace, logs, and artifacts per attempt on retry', async () => {
    const client = await connectClient('client-retry-isolation');
    const requestA = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `retry-a-${Date.now()}`,
    };
    const submitA = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: requestA })),
    );
    await client.callTool({
      name: 'job_wait',
      arguments: { job_id: submitA.job_id, wait_seconds: 60 },
    });
    const attemptA = getLatestAttempt(db, submitA.job_id);
    expect(attemptA).toBeTruthy();

    const requestB = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `retry-b-${Date.now()}`,
    };
    const submitB = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: requestB })),
    );
    await client.callTool({
      name: 'job_wait',
      arguments: { job_id: submitB.job_id, wait_seconds: 60 },
    });
    const attemptB = getLatestAttempt(db, submitB.job_id);
    expect(attemptB).toBeTruthy();
    if (!attemptA || !attemptB) {
      throw new Error('expected attempts for both jobs');
    }
    expect(attemptB.id).not.toBe(attemptA.id);

    const dirsA = {
      workspace: attemptWorkspaceDir(dataDir, attemptA.id),
      logs: attemptLogDir(dataDir, attemptA.id),
      artifacts: attemptArtifactsDir(dataDir, attemptA.id),
    };
    const dirsB = {
      workspace: attemptWorkspaceDir(dataDir, attemptB.id),
      logs: attemptLogDir(dataDir, attemptB.id),
      artifacts: attemptArtifactsDir(dataDir, attemptB.id),
    };

    await expect(access(dirsA.logs)).resolves.toBeUndefined();
    await expect(access(dirsB.logs)).resolves.toBeUndefined();
    await expect(access(dirsA.artifacts)).resolves.toBeUndefined();
    await expect(access(dirsB.artifacts)).resolves.toBeUndefined();
    await expect(access(dirsA.workspace)).rejects.toThrow();
    await expect(access(dirsB.workspace)).rejects.toThrow();
    expect(dirsA.logs).not.toBe(dirsB.logs);
    expect(dirsA.artifacts).not.toBe(dirsB.artifacts);

    await client.close();
  }, 180_000);

  it('emits secret_warning events when secret_policy=warn and still runs the job', async () => {
    const client = await connectClient('client-secret-warn');
    const envPath = join(fixtureDir, '.env');
    await writeFile(envPath, 'SECRET=1\n');
    try {
      const request = {
        ...baseJobRequest(fixtureDir),
        client_request_id: `secret-warn-${Date.now()}`,
        source_policy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'warn' as const,
        },
      };
      const submit = JSON.parse(
        textOf(await client.callTool({ name: 'job_submit', arguments: request })),
      );
      expect(submit.job_id).toBeTruthy();
      expect(submit.secret_warnings).toEqual(expect.arrayContaining(['.env']));

      await client.callTool({
        name: 'job_wait',
        arguments: { job_id: submit.job_id, wait_seconds: 60 },
      });

      const logs = JSON.parse(
        textOf(
          await client.callTool({
            name: 'job_logs',
            arguments: {
              job_id: submit.job_id,
              mode: 'events',
              max_bytes: 65_536,
              cursor: null,
            },
          }),
        ),
      );
      const warnings = (logs.events as Array<{ type: string; path?: string }>).filter(
        (event) => event.type === 'secret_warning' && event.path === '.env',
      );
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      await rm(envPath, { force: true }).catch(() => undefined);
      await client.close();
    }
  }, 120_000);

  it('injects canonical RBO_* env and emits env_override_ignored for user overrides', async () => {
    const client = await connectClient('client-env-override');
    const probeScript =
      process.platform === 'win32'
        ? 'Write-Output "RBO_JOB_ID=$env:RBO_JOB_ID"; Write-Output "RBO_ATTEMPT_ID=$env:RBO_ATTEMPT_ID"; Write-Output "RBO_ARTIFACT_DIR=$env:RBO_ARTIFACT_DIR"'
        : 'echo "RBO_JOB_ID=$RBO_JOB_ID"; echo "RBO_ATTEMPT_ID=$RBO_ATTEMPT_ID"; echo "RBO_ARTIFACT_DIR=$RBO_ARTIFACT_DIR"';
    const request = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `env-override-${Date.now()}`,
      execution: {
        ...baseJobRequest(fixtureDir).execution,
        script: probeScript,
        env: {
          RBO_JOB_ID: 'user-job',
          RBO_ATTEMPT_ID: 'user-attempt',
          RBO_ARTIFACT_DIR: '/user/artifacts',
          RBO_ARTIFACTS_DIR: '/user/wrong-plural',
        },
      },
    };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    expect(submit.job_id).toBeTruthy();

    await client.callTool({
      name: 'job_wait',
      arguments: { job_id: submit.job_id, wait_seconds: 60 },
    });

    const attempt = getLatestAttempt(db, submit.job_id);
    expect(attempt).toBeTruthy();
    if (!attempt) {
      throw new Error('expected attempt');
    }
    const stdout = await readFile(join(attemptLogDir(dataDir, attempt.id), 'stdout.log'), 'utf8');
    expect(stdout).toContain(`RBO_JOB_ID=${submit.job_id}`);
    expect(stdout).toContain(`RBO_ATTEMPT_ID=${attempt.id}`);
    expect(stdout).toContain(`RBO_ARTIFACT_DIR=${attemptArtifactsDir(dataDir, attempt.id)}`);
    expect(stdout).not.toContain('user-job');
    expect(stdout).not.toContain('user-attempt');
    expect(stdout).not.toContain('/user/artifacts');

    const logs = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_logs',
          arguments: {
            job_id: submit.job_id,
            mode: 'events',
            max_bytes: 65_536,
            cursor: null,
          },
        }),
      ),
    );
    const ignored = (logs.events as Array<{ type: string; name?: string }>).filter(
      (event) => event.type === 'env_override_ignored',
    );
    expect(ignored.map((e) => e.name).sort()).toEqual(
      ['RBO_ARTIFACTS_DIR', 'RBO_ARTIFACT_DIR', 'RBO_ATTEMPT_ID', 'RBO_JOB_ID'].sort(),
    );
    const secretWarnings = (logs.events as Array<{ type: string; name?: string }>).filter(
      (event) =>
        event.type === 'secret_warning' &&
        typeof event.name === 'string' &&
        event.name.startsWith('RBO_'),
    );
    expect(secretWarnings).toHaveLength(0);
    await client.close();
  }, 120_000);

  it('rejects source.cwd that escapes the isolated workspace', async () => {
    const client = await connectClient('client-cwd-escape');
    const request = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `cwd-escape-${Date.now()}`,
      source: { project_root: fixtureDir, cwd: '../../..' },
    };
    const result = await client.callTool({ name: 'job_submit', arguments: request });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cwd/i);
    await client.close();
  });

  it('cancels a job before it finishes (queued or running)', async () => {
    const client = await connectClient('client-queued-cancel');
    const sleepScript = process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60';
    const request = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `cancel-me-${Date.now()}`,
      execution: {
        ...baseJobRequest(fixtureDir).execution,
        script: sleepScript,
        timeout_seconds: 120,
      },
      artifacts: [],
    };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    expect(submit.job_id).toBeTruthy();

    const cancel = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_cancel',
          arguments: { job_id: submit.job_id, reason: 'test' },
        }),
      ),
    );
    expect(cancel.cancel_requested).toBe(true);

    const waited = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_wait',
          arguments: { job_id: submit.job_id, wait_seconds: 60 },
        }),
      ),
    );
    expect(waited.job.state).toBe('completed');
    expect(waited.job.outcome).toBe('cancelled');
    await client.close();
  }, 120_000);

  it('completes run_for_duration after duration_seconds even if the process is still running', async () => {
    const client = await connectClient('client-duration');
    const sleepScript = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const request: JobRequest = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `duration-${Date.now()}`,
      execution: {
        ...baseJobRequest(fixtureDir).execution,
        script: sleepScript,
        timeout_seconds: 60,
        completion: { type: 'run_for_duration', duration_seconds: 1 },
      },
      artifacts: [],
    };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    const waited = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_wait',
          arguments: { job_id: submit.job_id, wait_seconds: 30 },
        }),
      ),
    );
    expect(waited.job.state).toBe('completed');
    expect(waited.job.outcome).toBe('succeeded');
    await client.close();
  }, 60_000);

  it('completes run_until_log_match when success_pattern appears in stdout', async () => {
    const client = await connectClient('client-log-match');
    const script =
      process.platform === 'win32'
        ? 'Write-Output "boot"; Start-Sleep -Milliseconds 200; Write-Output "READY"; Start-Sleep -Seconds 30'
        : 'echo boot; sleep 0.2; echo READY; sleep 30';
    const request: JobRequest = {
      ...baseJobRequest(fixtureDir),
      client_request_id: `log-match-${Date.now()}`,
      execution: {
        ...baseJobRequest(fixtureDir).execution,
        script,
        timeout_seconds: 60,
        completion: {
          type: 'run_until_log_match',
          success_pattern: 'READY',
          max_duration_seconds: 30,
        },
      },
      artifacts: [],
    };
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    const waited = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_wait',
          arguments: { job_id: submit.job_id, wait_seconds: 30 },
        }),
      ),
    );
    expect(waited.job.state).toBe('completed');
    expect(waited.job.outcome).toBe('succeeded');
    await client.close();
  }, 60_000);
});
