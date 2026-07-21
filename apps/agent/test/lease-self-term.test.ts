import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
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
        waitForExit: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
        kill: (grace?: number) => Promise<void>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 9001;
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
      // TTL must outlast pre-spawn work (toolchain/secrets/build-cache); renew after spawn.
      lease_ttl_seconds: 5,
    });

    const exe = executor as unknown as {
      currentPrepare: unknown;
      materializedProjectPath: string;
    };
    exe.currentPrepare = {
      source_mode: 'full',
      attempt_id: 'att_hw',
      lease_id: 'lease_hw',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    exe.materializedProjectPath = projectPath;

    const spawnPromise = waitForSpawn();
    const runPromise = executor.handleRunJob({
      attempt_id: 'att_hw',
      lease_id: 'lease_hw',
      lease_epoch: 1,
    });

    await spawnPromise;
    // Re-arm after spawn so kill handler is registered before expiry.
    executor.renewLeaseDeadline(0.2);
    // Park as if disconnected — self-term must not need Controller.
    await executor.abandonOnDisconnect();
    await runPromise;

    expect(killCalls).toBeGreaterThanOrEqual(1);
    const meta = readAttemptMetadata(stateDir, 'att_hw');
    expect(meta?.status).toBe('terminal');
    expect(meta?.last_exit?.failure_category).toBe('lease_expired');
  });

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

    const exe = executor as unknown as {
      currentPrepare: unknown;
      materializedProjectPath: string;
    };
    exe.currentPrepare = {
      source_mode: 'full',
      attempt_id: 'att_safe',
      lease_id: 'lease_safe',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    exe.materializedProjectPath = projectPath;

    const spawnPromise = waitForSpawn();
    const runPromise = executor.handleRunJob({
      attempt_id: 'att_safe',
      lease_id: 'lease_safe',
      lease_epoch: 1,
    });

    await spawnPromise;
    await new Promise((r) => setTimeout(r, 300));
    expect(killCalls).toBe(0);
    const meta = readAttemptMetadata(stateDir, 'att_safe');
    // Safe jobs stay non-terminal on lease tick (Controller owns expiry).
    expect(meta?.status).not.toBe('terminal');
    expect(meta?.last_exit?.failure_category).not.toBe('lease_expired');

    // Expire the lease while still running — safe jobs must not self-kill.
    executor.renewLeaseDeadline(0.05);
    await new Promise((r) => setTimeout(r, 200));
    expect(killCalls).toBe(0);
    waitResolve?.({ exitCode: 0, signal: null });
    await runPromise;
  });
});
