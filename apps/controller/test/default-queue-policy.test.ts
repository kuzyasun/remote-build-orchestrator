import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ControllerIdentity } from '@rbo/shared';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleJobRun } from '../src/jobs/job-run.js';
import { getJob, getJobRequest } from '../src/jobs/lifecycle.js';
import {
  type SubmitJobContext,
  dispatchJobExecution,
  handleJobSubmit,
} from '../src/jobs/submit.js';
import { handleToolCall } from '../src/mcp/handlers.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

let fixtureDir: string;
let dataDir: string;
let db: ControllerDatabase;
let identity: ControllerIdentity;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'rbo-dqp-fix-'));
  dataDir = await mkdtemp(join(tmpdir(), 'rbo-dqp-ctrl-'));
  await runGit(fixtureDir, ['init']);
  await runGit(fixtureDir, ['config', 'user.email', 'dqp@example.com']);
  await runGit(fixtureDir, ['config', 'user.name', 'DQP']);
  await writeFile(join(fixtureDir, 'tracked.txt'), 'tracked');
  await runGit(fixtureDir, ['add', 'tracked.txt']);
  await runGit(fixtureDir, ['commit', '-m', 'init']);
  db = openDatabase(':memory:');
  migrateToLatest(db);
  identity = await ensureControllerIdentity(dataDir);
});

afterEach(async () => {
  // handleJobSubmit fires dispatch fire-and-forget (void dispatchJobExecution). Let any in-flight
  // local execution / DB writes settle before closing the connection, to avoid spurious
  // "database connection is not open" errors from the trailing dispatch.
  await new Promise((resolve) => setTimeout(resolve, 50));
  db.close();
  await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function buildCtx(overrides: Partial<SubmitJobContext> = {}): SubmitJobContext {
  return {
    clientId: 'dqp-client',
    controllerIdentity: identity,
    db,
    dataDir,
    allowedProjectRoots: [fixtureDir],
    allowedArtifactDestinations: [],
    // No remote configured: allow local fallback so the only thing that keeps a job queued is
    // the queue policy, not a disabled local executor.
    allowLocalFallback: true,
    // Local-only fixture repos have no allowlisted remote, so git-overlay capture is impossible;
    // opt in to the full-snapshot path to exercise real submit capture.
    allowFullSnapshotFallback: true,
    ...overrides,
  };
}

describe('defaultQueuePolicy (queue jobs when no Agent has capacity)', () => {
  it('queues a job that omits queue_policy when the Controller default is "wait"', async () => {
    // A job with no remote-eligible Agent and `default_queue_policy: wait` must stay `queued`
    // (waiting for an Agent) rather than falling back to the Controller host or failing.
    const ctx = buildCtx({ defaultQueuePolicy: 'wait' });
    const submit = (await handleJobSubmit(ctx, {
      client_request_id: 'req_wait',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo wait' },
      // queue_policy deliberately omitted — the Controller default applies
      requirements: { os: ['nonexistent-os'] },
    })) as Record<string, unknown>;

    expect(submit.state).toBe('queued');
    expect(submit.job_id).toMatch(/^job_/);

    const job = getJob(db, String(submit.job_id));
    expect(job?.state).toBe('queued');

    // The persisted request carries the resolved policy so downstream readers (scheduler,
    // lease-reject handler) see a concrete value without re-deriving it.
    const persisted = getJobRequest(db, String(submit.job_id));
    expect(persisted?.queue_policy).toBe('wait');
  });

  it('still resolves to local_fallback when the Controller default is "local_fallback"', async () => {
    const ctx = buildCtx({ defaultQueuePolicy: 'local_fallback' });
    const submit = (await handleJobSubmit(ctx, {
      client_request_id: 'req_fallback',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo fallback' },
    })) as Record<string, unknown>;

    expect(submit.job_id).toMatch(/^job_/);
    const persisted = getJobRequest(db, String(submit.job_id));
    expect(persisted?.queue_policy).toBe('local_fallback');
  });

  it('an explicit queue_policy always wins over the Controller default', async () => {
    const ctx = buildCtx({ defaultQueuePolicy: 'local_fallback' });
    const submit = (await handleJobSubmit(ctx, {
      client_request_id: 'req_explicit_wait',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo explicit' },
      queue_policy: 'wait',
      requirements: { os: ['nonexistent-os'] },
    })) as Record<string, unknown>;

    const persisted = getJobRequest(db, String(submit.job_id));
    expect(persisted?.queue_policy).toBe('wait');
  });

  it('dispatchJobExecution leaves a queued wait-policy job queued when no Agent is eligible', async () => {
    // Mirrors the dispatcher's re-dispatch path (tryDispatchQueuedJobs): a job already persisted
    // with queue_policy=wait and no matching Agent stays queued, it is not failed.
    const ctx = buildCtx({ defaultQueuePolicy: 'wait' });
    const submit = (await handleJobSubmit(ctx, {
      client_request_id: 'req_redispatch',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo redispatch' },
      requirements: { os: ['nonexistent-os'] },
    })) as Record<string, unknown>;
    const jobId = String(submit.job_id);

    // Re-run dispatch directly (as the lease-sweep / agent-event triggers do).
    const persisted = getJobRequest(db, jobId);
    expect(persisted).not.toBeNull();
    await dispatchJobExecution(ctx, jobId, persisted as never);

    const queued = getJob(db, jobId);
    expect(queued?.state).toBe('queued');
    expect(JSON.parse(queued?.result_json ?? '{}')).toMatchObject({
      no_match: { category: 'no_matching_agent', retryable: false },
    });
    expect(JSON.parse(queued?.result_json ?? '{}').no_match.hint).toMatch(/job_run/);
    expect(JSON.parse(queued?.result_json ?? '{}').no_match.hint).not.toContain('queue_policy');

    const resumed = await handleJobRun(ctx, { job_id: jobId, wait_seconds: 0 });
    expect(resumed).toMatchObject({
      job_id: jobId,
      state: 'queued',
      resume: true,
      no_match: { category: 'no_matching_agent', retryable: false },
    });
  });

  it('falls back to local_fallback when defaultQueuePolicy is unset (back-compat)', async () => {
    // Tests and programmatic callers that do not supply a Controller default keep the historical
    // local-fallback behavior.
    const ctx = buildCtx();
    const submit = (await handleJobSubmit(ctx, {
      client_request_id: 'req_legacy',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo legacy' },
    })) as Record<string, unknown>;

    const persisted = getJobRequest(db, String(submit.job_id));
    expect(persisted?.queue_policy).toBe('local_fallback');
  });

  it('idempotent re-submit returns the first (normalized) response regardless of the second policy', async () => {
    // Re-submitting the same client_request_id must return the cached response from the first
    // submission. The queue_policy normalization of the second call has no persisted side effect
    // because handleJobSubmit returns the cached response_json before any write.
    const ctx = buildCtx({ defaultQueuePolicy: 'wait' });
    const first = (await handleJobSubmit(ctx, {
      client_request_id: 'req_idempotent',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo idem' },
      requirements: { os: ['nonexistent-os'] },
    })) as Record<string, unknown>;
    const firstJobId = first.job_id;

    // Second call explicitly requests a different policy — must be ignored (cached response wins).
    const second = (await handleJobSubmit(ctx, {
      client_request_id: 'req_idempotent',
      source: { project_root: fixtureDir, cwd: '.' },
      execution: { script: 'echo idem' },
      queue_policy: 'fail_fast',
      requirements: { os: ['nonexistent-os'] },
    })) as Record<string, unknown>;

    expect(second.job_id).toBe(firstJobId);
    // The persisted policy stays the first normalized value (wait), not fail_fast.
    const persisted = getJobRequest(db, String(firstJobId));
    expect(persisted?.queue_policy).toBe('wait');
  });

  it('applies the Controller default through the MCP job_submit tool layer', async () => {
    // Exercises the full run -> startControllerServer -> buildToolContext -> submitContext ->
    // normalizer path at the MCP tool-call boundary (what AI clients actually invoke), without a
    // full HTTP server: handleToolCall receives a ToolContext carrying defaultQueuePolicy.
    const ctx = buildCtx({ defaultQueuePolicy: 'wait' });
    const result = (await handleToolCall(
      {
        db,
        identity: { client_id: 'mcp-client', transport: 'http' },
        dataDir,
        controllerIdentity: identity,
        allowedProjectRoots: [fixtureDir],
        allowedArtifactDestinations: [],
        defaultQueuePolicy: 'wait',
        allowFullSnapshotFallback: true,
      },
      'job_submit',
      {
        client_request_id: 'req_mcp_wait',
        source: { project_root: fixtureDir, cwd: '.' },
        execution: { script: 'echo mcp' },
        // queue_policy omitted — Controller default (wait) must apply
        requirements: { os: ['nonexistent-os'] },
      },
    )) as Record<string, unknown>;

    expect(result.state).toBe('queued');
    expect(getJobRequest(db, String(result.job_id))?.queue_policy).toBe('wait');
  });
});
