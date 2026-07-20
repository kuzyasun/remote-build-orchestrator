import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';

let executorRef: AgentJobExecutor | null = null;
let waitSignal: { cancelled: boolean } | null = null;

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
        waitForExit: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
        kill: (grace?: number) => Promise<void>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      child.waitForExit = async () => ({ exitCode: null, signal: 'SIGTERM' });
      child.kill = async () => undefined;
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
    })),
    openAttemptSpool: vi.fn(async () => ({
      dir: '/dev/null',
      logs: {
        logDir: '/dev/null',
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        eventsPath: '/dev/null',
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

describe('Agent cancelSignal race across spawn', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-cancel-'));
    executorRef = null;
    waitSignal = null;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('keeps cancel observed by waitForCompletion when cancel arrives during spawn', async () => {
    const holder: { current: AgentJobExecutor | null } = { current: null };
    const socket = mockSocket(holder);
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
    });
    holder.current = executor;
    executorRef = executor;

    const projectPath = join(stateDir, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'keep.txt'), 'x');

    executor.handleLeaseOffer({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
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

    const exe = executor as unknown as {
      currentPrepare: unknown;
      materializedProjectPath: string;
    };
    exe.currentPrepare = {
      source_mode: 'full',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    exe.materializedProjectPath = projectPath;

    await executor.handleRunJob({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
    });

    // Cancel during spawn must still be visible to waitForCompletion's signal
    // and must produce a cancelled terminal outcome (not a wiped signal).
    expect(waitSignal?.cancelled).toBe(true);
    const exitFrame = socket.sent.find((frame) => frame.type === 'job_exit');
    expect(exitFrame?.payload).toMatchObject({ outcome: 'cancelled' });
  });
});
