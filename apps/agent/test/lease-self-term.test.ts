import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  collectArtifactFiles,
  runCleanupScript,
  spawnJobScript,
  writeJobScript,
} from '@rbo/executor';
import { LeaseOfferPayloadSchema } from '@rbo/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor, readLeaseClock } from '../src/executor/index.js';
import { readAttemptMetadata } from '../src/recovery/attempt-metadata.js';

let killCalls = 0;
let waitResolve:
  | ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void)
  | null = null;
let spawnDone: (() => void) | null = null;

vi.mock('@rbo/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rbo/executor')>();
  return {
    ...actual,
    spawnJobScript: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: number;
        waitForStart: () => Promise<{ started: true }>;
        waitForExit: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
        kill: (grace?: number) => Promise<void>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 9001;
      child.waitForStart = async () => ({ started: true });
      child.waitForExit = () =>
        new Promise((resolve) => {
          waitResolve = resolve;
        });
      child.kill = async () => {
        killCalls += 1;
        waitResolve?.({ exitCode: null, signal: 'SIGTERM' });
        waitResolve = null;
      };
      Object.assign(child, { ignoredRboEnvKeys: [] as string[] });
      spawnDone?.();
      return child;
    }),
    waitForCompletion: vi.fn(
      async ({ child }: { child: { waitForExit: () => Promise<unknown> } }) => {
        const result = await child.waitForExit();
        return {
          type: 'exit' as const,
          exitCode: (result as { exitCode: number | null }).exitCode,
        };
      },
    ),
    writeJobScript: vi.fn(async () => 'script'),
    ensureAttemptLogs: vi.fn(async () => ({
      logDir: '/dev/null',
      stdoutPath: '/dev/null',
      stderrPath: '/dev/null',
      eventsPath: '/dev/null',
      chunksPath: '/dev/null',
    })),
    openAttemptSpool: vi.fn(async () => ({
      dir: '/dev/null',
      logs: {
        logDir: '/dev/null',
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        eventsPath: '/dev/null',
        chunksPath: '/dev/null',
      },
      chunksPath: '/dev/null',
      ackPath: '/dev/null',
      nextSequence: 1,
      streamOffsets: { stdout: 0, stderr: 0 },
    })),
    appendChunk: vi.fn(async () => ({ sequence: 1 })),
    appendLogChunk: vi.fn(async () => undefined),
    readAck: vi.fn(async () => 0),
    writeAck: vi.fn(async () => undefined),
    totalBytes: vi.fn(async () => 0),
    iterUnacked: vi.fn(async function* () {}),
    collectArtifactFiles: vi.fn(async () => ({ files: [] })),
    runCleanupScript: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
  };
});

function mockSocket(executorHolder: { current: AgentJobExecutor | null }): WebSocket & {
  sent: Array<Record<string, unknown>>;
} {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      sent.push(frame);
      if (frame.type === 'artifact_manifest' && executorHolder.current) {
        const payload = frame.payload as {
          attempt_id: string;
          lease_id: string;
          lease_epoch: number;
        };
        queueMicrotask(() => {
          executorHolder.current?.handleArtifactUploadGrant({
            attempt_id: payload.attempt_id,
            lease_id: payload.lease_id,
            lease_epoch: payload.lease_epoch,
            artifacts: [],
          });
        });
      }
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

async function waitForSpawn(): Promise<void> {
  await new Promise<void>((resolve) => {
    spawnDone = resolve;
  });
}

describe('Lease-expiry self-termination (destructive/hardware)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-lease-term-'));
    killCalls = 0;
    waitResolve = null;
    spawnDone = null;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(stateDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('kills destructive job at lease deadline without Controller cancel', async () => {
    const holder: { current: AgentJobExecutor | null } = { current: null };
    const socket = mockSocket(holder);
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
    });
    holder.current = executor;

    const projectPath = join(stateDir, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'keep.txt'), 'x');
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });

    executor.handleLeaseOffer({
      attempt_id: 'att_hw',
      lease_id: 'lease_hw',
      lease_epoch: 1,
      job_id: 'job_hw',
      job_request: {
        client_request_id: 'req_hw',
        risk_level: 'hardware',
        source: { project_root: projectPath, cwd: '.' },
        execution: {
          shell: 'bash',
          script: 'sleep 999',
          cancel_grace_seconds: 1,
        },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_1',
        content_id: 'cid',
        size_bytes: 1,
        sha256: 'ab',
      },
      lease_ttl_seconds: 5,
    });

    const attempt = (
      executor as unknown as {
        attempts: Map<string, { prepare: unknown; materializedProjectPath: string | null }>;
      }
    ).attempts.get('att_hw');
    if (!attempt) {
      throw new Error('expected att_hw runtime');
    }
    attempt.prepare = {
      source_mode: 'full',
      attempt_id: 'att_hw',
      lease_id: 'lease_hw',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    attempt.materializedProjectPath = projectPath;

    const spawnPromise = waitForSpawn();
    const runPromise = executor.handleRunJob({
      attempt_id: 'att_hw',
      lease_id: 'lease_hw',
      lease_epoch: 1,
    });

    await spawnPromise;
    // Park as if disconnected — self-term must not need Controller.
    await executor.abandonOnDisconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    await runPromise;

    expect(killCalls).toBeGreaterThanOrEqual(1);
    const meta = readAttemptMetadata(stateDir, 'att_hw');
    expect(meta?.status).toBe('terminal');
    expect(meta?.last_exit?.failure_category).toBe('lease_expired');
  });

  it.each(['destructive', 'hardware'] as const)(
    'does not spawn a %s job when its deadline passes during pre-spawn work',
    async (riskLevel) => {
      const socket = mockSocket({ current: null });
      const executor = new AgentJobExecutor(socket, {
        stateDir,
        controllerFingerprint: 'sha256:test',
        gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
        repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
      });
      const projectPath = join(stateDir, 'project');
      await mkdir(projectPath, { recursive: true });
      vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
      const start = Date.now();
      const lease = { attempt_id: 'att_expired', lease_id: 'lease_expired', lease_epoch: 1 };
      executor.handleLeaseOffer(
        LeaseOfferPayloadSchema.parse({
          ...lease,
          job_id: 'job_expired',
          job_request: {
            client_request_id: 'req_expired',
            risk_level: riskLevel,
            source: { project_root: projectPath, cwd: '.' },
            execution: { script: 'echo ok' },
          },
          snapshot_metadata: {
            snapshot_id: 'snp_1',
            content_id: 'cid',
            size_bytes: 1,
            sha256: 'ab',
          },
          lease_ttl_seconds: 5,
        }),
      );
      const attempt = (
        executor as unknown as {
          attempts: Map<string, { prepare: unknown; materializedProjectPath: string | null }>;
        }
      ).attempts.get(lease.attempt_id);
      if (!attempt) throw new Error('expected reserved attempt');
      attempt.prepare = { ...lease, source_mode: 'full' };
      attempt.materializedProjectPath = projectPath;
      vi.mocked(writeJobScript).mockImplementationOnce(async () => {
        // Expire the deadline without invoking the queued timer callback.
        vi.setSystemTime(start + 5_000);
        return 'script';
      });

      await executor.handleRunJob(lease);

      expect(writeJobScript).toHaveBeenCalledOnce();
      expect(spawnJobScript).not.toHaveBeenCalled();
      expect(socket.sent.find(({ type }) => type === 'job_exit')?.payload).toMatchObject({
        outcome: 'failed',
        failure_category: 'lease_expired',
      });
      expect(executor.isBusy()).toBe(false);
    },
  );

  it('does not self-kill safe jobs at lease expiry', async () => {
    const holder: { current: AgentJobExecutor | null } = { current: null };
    const socket = mockSocket(holder);
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
    });
    holder.current = executor;

    const projectPath = join(stateDir, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'keep.txt'), 'x');
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });

    executor.handleLeaseOffer({
      attempt_id: 'att_safe',
      lease_id: 'lease_safe',
      lease_epoch: 1,
      job_id: 'job_safe',
      job_request: {
        client_request_id: 'req_safe',
        risk_level: 'safe',
        source: { project_root: projectPath, cwd: '.' },
        execution: {
          shell: 'bash',
          script: 'sleep 999',
          cancel_grace_seconds: 1,
        },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_1',
        content_id: 'cid',
        size_bytes: 1,
        sha256: 'ab',
      },
      lease_ttl_seconds: 5,
    });

    const attempt = (
      executor as unknown as {
        attempts: Map<string, { prepare: unknown; materializedProjectPath: string | null }>;
      }
    ).attempts.get('att_safe');
    if (!attempt) {
      throw new Error('expected att_safe runtime');
    }
    attempt.prepare = {
      source_mode: 'full',
      attempt_id: 'att_safe',
      lease_id: 'lease_safe',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    attempt.materializedProjectPath = projectPath;

    const spawnPromise = waitForSpawn();
    const runPromise = executor.handleRunJob({
      attempt_id: 'att_safe',
      lease_id: 'lease_safe',
      lease_epoch: 1,
    });

    await spawnPromise;
    expect(killCalls).toBe(0);
    const meta = readAttemptMetadata(stateDir, 'att_safe');
    // Safe jobs stay non-terminal on lease tick (Controller owns expiry).
    expect(meta?.status).not.toBe('terminal');
    expect(meta?.last_exit?.failure_category).not.toBe('lease_expired');

    // Expire the lease while still running — safe jobs must not self-kill.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killCalls).toBe(0);
    waitResolve?.({ exitCode: 0, signal: null });
    await runPromise;
  });

  async function startRiskyCleanup() {
    const holder: { current: AgentJobExecutor | null } = { current: null };
    const socket = mockSocket(holder);
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
    });
    holder.current = executor;
    const lease = { attempt_id: 'att_cleanup', lease_id: 'lease_cleanup', lease_epoch: 1 };
    const projectPath = join(stateDir, 'workspaces', lease.attempt_id, 'workspace', 'main_mount');
    await mkdir(projectPath, { recursive: true });
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    executor.handleLeaseOffer(
      LeaseOfferPayloadSchema.parse({
        ...lease,
        job_id: 'job_cleanup',
        job_request: {
          client_request_id: 'req_cleanup',
          risk_level: 'hardware',
          source: { project_root: projectPath, cwd: '.' },
          execution: { script: 'echo primary', cleanup_script: 'echo cleanup' },
        },
        snapshot_metadata: { snapshot_id: 'snp_1', content_id: 'cid', size_bytes: 1, sha256: 'ab' },
        lease_ttl_seconds: 5,
      }),
    );
    const attempt = (
      executor as unknown as {
        attempts: Map<string, { prepare: unknown; materializedProjectPath: string | null }>;
      }
    ).attempts.get(lease.attempt_id);
    if (!attempt) throw new Error('expected reserved attempt');
    attempt.prepare = { ...lease, source_mode: 'full' };
    attempt.materializedProjectPath = projectPath;
    const spawnPromise = waitForSpawn();
    const run = executor.handleRunJob(lease);
    await spawnPromise;
    waitResolve?.({ exitCode: 0, signal: null });
    return { executor, socket, lease, run };
  }

  it('fences cleanup after an expiry during staging and preserves staged bytes for recovery', async () => {
    const staging = Promise.withResolvers<void>();
    const releaseStaging = Promise.withResolvers<void>();
    const artifact = join(stateDir, 'source-artifact.txt');
    const contents = 'artifact bytes';
    await writeFile(artifact, contents);
    vi.mocked(collectArtifactFiles).mockImplementationOnce(async () => {
      staging.resolve();
      await releaseStaging.promise;
      return {
        files: [
          {
            logical_name: 'out.txt',
            sourcePath: artifact,
            size_bytes: contents.length,
            sha256: createHash('sha256').update(contents).digest('hex'),
          },
        ],
        skipped: [],
        summary: { rules: [] },
        tempPaths: [],
      };
    });
    const cleanup = vi.mocked(runCleanupScript).mockImplementationOnce(async (input) => {
      expect(input.getWindowsStartBudgetMs?.()).toBe(0);
      expect(input.cancelSignal?.reason).toEqual(new Error('lease expired'));
      return { exitCode: null, timedOut: false, message: 'Cleanup script skipped: lease expired' };
    });
    const { executor, socket, lease, run } = await startRiskyCleanup();
    await staging.promise;
    Object.assign(socket, { readyState: 3 });
    await executor.abandonOnDisconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    releaseStaging.resolve();
    await run;

    expect(cleanup).toHaveBeenCalledOnce();
    expect(killCalls).toBe(0);
    expect(readAttemptMetadata(stateDir, lease.attempt_id)).toMatchObject({
      status: 'completed_awaiting_upload',
      last_exit: { outcome: 'succeeded', exit_code: 0 },
      artifact_staging: 'complete',
      artifact_manifest: [{ logical_name: 'out.txt' }],
      cleanup_result: { message: 'Cleanup script skipped: lease expired', timed_out: false },
    });
    await expect(
      readFile(join(stateDir, 'artifacts', lease.attempt_id, 'out.txt'), 'utf8'),
    ).resolves.toBe(contents);
  });

  it.each(['expiry', 'cancel', 'abandon'] as const)(
    'waits for running cleanup to stop on %s and preserves the primary outcome',
    async (interruption) => {
      const started = Promise.withResolvers<string>();
      const cancelled = Promise.withResolvers<unknown>();
      const closed = Promise.withResolvers<void>();
      vi.mocked(runCleanupScript).mockImplementationOnce(async (input) => {
        input.cancelSignal?.addEventListener(
          'abort',
          () => cancelled.resolve(input.cancelSignal?.reason),
          { once: true },
        );
        started.resolve(input.workspacePath);
        await closed.promise;
        return {
          exitCode: null,
          timedOut: false,
          message: `Cleanup script interrupted: ${input.cancelSignal?.reason.message}`,
        };
      });
      const { executor, socket, lease, run } = await startRiskyCleanup();
      const workspacePath = await started.promise;
      const interrupt = {
        expiry: () => vi.advanceTimersByTimeAsync(5_000),
        cancel: () => executor.handleCancelJob({ ...lease, grace_seconds: 1 }),
        abandon: () => executor.forceAbandon(),
      };
      const reasons = {
        expiry: 'lease expired',
        cancel: 'job cancelled',
        abandon: 'attempt abandoned',
      };
      const interrupted = interrupt[interruption]();
      try {
        await expect(cancelled.promise).resolves.toEqual(new Error(reasons[interruption]));
        await expect(access(workspacePath)).resolves.toBeUndefined();
        expect(executor.isBusy()).toBe(true);
      } finally {
        closed.resolve();
      }
      await interrupted;
      await run;
      await expect(access(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });

      const exits = socket.sent.filter(({ type }) => type === 'job_exit');
      expect(exits.map(({ payload }) => payload)).toEqual([
        expect.objectContaining({ outcome: 'succeeded', exit_code: 0 }),
      ]);
      expect(readAttemptMetadata(stateDir, lease.attempt_id)).toMatchObject({
        status: 'completed_awaiting_upload',
        last_exit: { outcome: 'succeeded', exit_code: 0 },
        cleanup_result: {
          message: `Cleanup script interrupted: ${reasons[interruption]}`,
          timed_out: false,
        },
      });
      expect(killCalls).toBe(0);
      expect(executor.isBusy()).toBe(false);
    },
  );

  it('renews only the confirmed live lease on its authorized socket, measured from send time', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const start = Date.now();
    const holder = { current: null };
    const socket = mockSocket(holder);
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
      maxJobs: 2,
    });
    const offer = LeaseOfferPayloadSchema.parse({
      attempt_id: 'att_a',
      lease_id: 'lease_a',
      lease_epoch: 1,
      job_id: 'job_a',
      job_request: {
        client_request_id: 'req_a',
        risk_level: 'safe',
        source: { project_root: stateDir, cwd: '.' },
        execution: { script: 'echo hi' },
      },
      snapshot_metadata: { snapshot_id: 'snp_a', content_id: 'cid', size_bytes: 1, sha256: 'ab' },
      lease_ttl_seconds: 5,
    });
    executor.handleLeaseOffer(offer);
    executor.handleLeaseOffer({
      ...offer,
      attempt_id: 'att_b',
      lease_id: 'lease_b',
      job_id: 'job_b',
    });

    const deadline = (attemptId: string) =>
      Date.parse(readAttemptMetadata(stateDir, attemptId)?.lease_deadline ?? '');
    const lease = { attempt_id: offer.attempt_id, lease_id: offer.lease_id, lease_epoch: 1 };
    await vi.advanceTimersByTimeAsync(2_000);
    const sentAt = readLeaseClock();
    await vi.advanceTimersByTimeAsync(1_000);
    executor.confirmLeaseRenewal(
      {
        heartbeat_message_id: 'msg_1',
        lease_ttl_seconds: 5,
        renewed_leases: [
          { ...lease, lease_id: 'stale' },
          { ...lease, lease_epoch: 2 },
        ],
      },
      sentAt,
    );
    expect(deadline(offer.attempt_id)).toBe(start + 5_000);

    const ack = { heartbeat_message_id: 'msg_2', lease_ttl_seconds: 5, renewed_leases: [lease] };
    const reconnectedSocket = mockSocket(holder);
    executor.attachSocket(reconnectedSocket);
    executor.confirmLeaseRenewal(ack, sentAt);
    expect(deadline(offer.attempt_id)).toBe(start + 5_000);
    executor.authorizeArtifactUpload(offer.attempt_id, reconnectedSocket);
    executor.confirmLeaseRenewal(ack, sentAt);
    expect(deadline(offer.attempt_id)).toBe(start + 7_000);
    expect(deadline('att_b')).toBe(start + 5_000);

    // A valid heartbeat sent after a clock correction can still extend a live lease.
    vi.setSystemTime(start - 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const sentAfterRollback = readLeaseClock();
    await vi.advanceTimersByTimeAsync(500);
    executor.confirmLeaseRenewal(ack, sentAfterRollback);
    const correctedDeadline = sentAfterRollback.epochMs + 5_000;
    expect(deadline(offer.attempt_id)).toBe(correctedDeadline);
    // An out-of-order ACK with a larger UTC timestamp cannot replace it.
    executor.confirmLeaseRenewal(ack, sentAt);
    expect(deadline(offer.attempt_id)).toBe(correctedDeadline);

    await vi.advanceTimersByTimeAsync(4_000);
    const lateSentAt = readLeaseClock();
    // Move the wall clock past the deadline without running the timeout callback.
    vi.setSystemTime(correctedDeadline + 1);
    executor.confirmLeaseRenewal(ack, lateSentAt);
    expect(deadline(offer.attempt_id)).toBe(correctedDeadline);

    // Observed expiry is irreversible even before the original monotonic deadline.
    vi.setSystemTime(sentAfterRollback.epochMs);
    executor.confirmLeaseRenewal(ack, lateSentAt);
    expect(deadline(offer.attempt_id)).toBe(correctedDeadline);
    await executor.forceAbandon();
  });
});
