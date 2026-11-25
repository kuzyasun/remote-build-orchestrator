import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ManagedChildProcess, runCleanupScript, spawnJobScript } from '@rbo/executor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import type { AttemptMetadata } from '../src/recovery/attempt-metadata.js';

let executorRef: AgentJobExecutor | null = null;
let waitSignal: { cancelled: boolean } | null = null;
let failedMetadataStatus: AttemptMetadata['status'] | null = null;

vi.mock('../src/recovery/attempt-metadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/recovery/attempt-metadata.js')>();
  return {
    ...actual,
    writeAttemptMetadata: (stateDir: string, meta: AttemptMetadata) => {
      if (meta.status === failedMetadataStatus) {
        throw new Error('simulated local metadata write failure');
      }
      actual.writeAttemptMetadata(stateDir, meta);
    },
  };
});

vi.mock('@rbo/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rbo/executor')>();
  return {
    ...actual,
    spawnJobScript: vi.fn(() => {
      // Cancel during spawn, after handleRunJob's pre-spawn cancel check and
      // before it replaces cancelSignal / registers activeProcessKill.
      if (executorRef) {
        void executorRef.handleCancelJob({
          attempt_id: 'att_1',
          lease_id: 'lease_1',
          lease_epoch: 1,
          grace_seconds: 1,
          reason: 'operator cancel during spawn',
        });
      }
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
      child.pid = 4242;
      child.waitForStart = async () => ({ started: true });
      child.waitForExit = async () => ({ exitCode: null, signal: 'SIGTERM' });
      child.kill = async () => undefined;
      Object.assign(child, { ignoredRboEnvKeys: [] as string[] });
      return child;
    }),
    waitForCompletion: vi.fn(async ({ signal }: { signal: { cancelled: boolean } }) => {
      waitSignal = signal;
      return { type: 'exit' as const, exitCode: signal.cancelled ? null : 0 };
    }),
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
        queueMicrotask(() => {
          executorHolder.current?.handleArtifactUploadGrant({
            attempt_id: 'att_1',
            lease_id: 'lease_1',
            lease_epoch: 1,
            artifacts: [],
          });
        });
      }
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

describe('Agent process supervision across spawn', () => {
  let stateDir: string;
  const lease = { attempt_id: 'att_1', lease_id: 'lease_1', lease_epoch: 1 };

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-cancel-'));
    executorRef = null;
    waitSignal = null;
    failedMetadataStatus = null;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function setup() {
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

    executor.handleLeaseOffer({
      ...lease,
      job_id: 'job_1',
      job_request: {
        client_request_id: 'req_1',
        source: { project_root: projectPath, cwd: '.' },
        execution: {
          shell: 'bash',
          script: 'sleep 30',
          cancel_grace_seconds: 1,
        },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_1',
        content_id: 'cid',
        size_bytes: 1,
        sha256: 'ab',
      },
      lease_ttl_seconds: 300,
    });

    const attempt = (
      executor as unknown as {
        attempts: Map<string, { prepare: unknown; materializedProjectPath: string | null }>;
      }
    ).attempts.get(lease.attempt_id);
    if (!attempt) {
      throw new Error('expected att_1 runtime');
    }
    attempt.prepare = {
      source_mode: 'full',
      ...lease,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    attempt.materializedProjectPath = projectPath;
    return { executor, socket };
  }

  it('keeps cancel observed by waitForCompletion when cancel arrives during spawn', async () => {
    const { executor, socket } = await setup();
    executorRef = executor;
    await executor.handleRunJob(lease);

    // Cancel during spawn must still be visible to waitForCompletion's signal
    // and must produce a cancelled terminal outcome (not a wiped signal).
    expect(waitSignal?.cancelled).toBe(true);
    const exitFrame = socket.sent.find((frame) => frame.type === 'job_exit');
    expect(exitFrame?.payload).toMatchObject({ outcome: 'cancelled' });
  });

  it('waits for the launched process to close after running metadata fails', async () => {
    const { executor, socket } = await setup();
    const exited = Promise.withResolvers<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>();
    const kill = vi.fn(async () => undefined);
    vi.mocked(spawnJobScript).mockReturnValueOnce(
      Object.assign(new ManagedChildProcess({ pid: -1, waitForExit: () => exited.promise, kill }), {
        ignoredRboEnvKeys: [],
      }),
    );
    failedMetadataStatus = 'running';

    const running = executor.handleRunJob(lease);
    try {
      await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
      expect(kill).toHaveBeenCalledWith(1);
      expect(executor.getActiveAttemptId()).toBe(lease.attempt_id);
      expect(socket.sent.some((frame) => frame.type === 'job_exit')).toBe(false);
      await expect(access(join(stateDir, 'workspaces', lease.attempt_id))).resolves.toBeUndefined();
    } finally {
      exited.resolve({ exitCode: null, signal: 'SIGTERM' });
      await running;
    }

    expect(executor.getActiveAttemptId()).toBeNull();
    await expect(access(join(stateDir, 'workspaces', lease.attempt_id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(socket.sent.find((frame) => frame.type === 'job_exit')?.payload).toMatchObject({
      outcome: 'failed',
      failure_category: 'internal',
      failure_message: expect.stringContaining('simulated local metadata write failure'),
    });
  });

  it('retains the completed outcome and runs cleanup if completion metadata cannot be written', async () => {
    const { executor, socket } = await setup();
    const kill = vi.fn(async () => undefined);
    vi.mocked(spawnJobScript).mockReturnValueOnce(
      Object.assign(
        new ManagedChildProcess({
          pid: -1,
          waitForStart: async () => ({ started: true }),
          waitForExit: async () => ({ exitCode: 0, signal: null }),
          kill,
        }),
        { ignoredRboEnvKeys: [] },
      ),
    );
    failedMetadataStatus = 'completed_awaiting_upload';

    await executor.handleRunJob(lease);

    expect(kill).not.toHaveBeenCalled();
    expect(runCleanupScript).toHaveBeenCalledOnce();
    expect(
      socket.sent.filter((frame) => frame.type === 'job_exit').map((frame) => frame.payload),
    ).toEqual([expect.objectContaining({ outcome: 'succeeded', exit_code: 0 })]);
    expect(socket.sent.some((frame) => frame.type === 'cleanup_complete')).toBe(true);
    expect(executor.getActiveAttemptId()).toBeNull();
  });

  it('keeps ownership without reporting a job start when the helper denies launch', async () => {
    const { executor, socket } = await setup();
    const start = Promise.withResolvers<{ started: false; errorMessage: string }>();
    const kill = vi.fn(async () => undefined);
    vi.mocked(spawnJobScript).mockReturnValueOnce(
      Object.assign(
        new ManagedChildProcess({
          pid: -1,
          waitForStart: () => start.promise,
          waitForExit: async () => ({ exitCode: null, signal: null }),
          kill,
        }),
        { ignoredRboEnvKeys: [] },
      ),
    );

    const running = executor.handleRunJob(lease);
    try {
      await vi.waitFor(() => expect(spawnJobScript).toHaveBeenCalledOnce());
      expect(executor.getActiveAttemptId()).toBe(lease.attempt_id);
      expect(socket.sent.some((frame) => frame.type === 'job_started')).toBe(false);
    } finally {
      start.resolve({ started: false, errorMessage: 'Job start authorization expired' });
      await running;
    }

    expect(socket.sent.some((frame) => frame.type === 'job_started')).toBe(false);
    expect(socket.sent.find((frame) => frame.type === 'job_exit')?.payload).toMatchObject({
      outcome: 'failed',
      failure_category: 'process_spawn',
      failure_message: 'Job start authorization expired',
    });
  });

  it('asks the tree adapter to clean up after a bookkeeping failure even if the wrapper closed', async () => {
    const { executor } = await setup();
    const kill = vi.fn(async () => undefined);
    vi.mocked(spawnJobScript).mockReturnValueOnce(
      Object.assign(
        new ManagedChildProcess({
          pid: -1,
          waitForExit: async () => ({ exitCode: 0, signal: null }),
          kill,
        }),
        { ignoredRboEnvKeys: [] },
      ),
    );
    failedMetadataStatus = 'running';

    await executor.handleRunJob(lease);

    expect(kill).toHaveBeenCalledOnce();
    expect(executor.getActiveAttemptId()).toBeNull();
  });
});
