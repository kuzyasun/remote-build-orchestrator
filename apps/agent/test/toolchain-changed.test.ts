/**
 * Phase 4 §1.7 — toolchain_changed rejection before spawn.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import { DEFAULT_REPO_CACHE_CONFIG } from '../src/repos/mirror.js';

vi.mock('@rbo/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rbo/executor')>();
  return {
    ...actual,
    spawnJobScript: vi.fn(() => {
      throw new Error('spawnJobScript must not run when toolchain_changed rejects');
    }),
    writeJobScript: vi.fn(async () => 'script'),
    openAttemptSpool: vi.fn(async (dir: string) => actual.openAttemptSpool(dir)),
    appendChunk: vi.fn(actual.appendChunk),
    readAck: vi.fn(actual.readAck),
    writeAck: vi.fn(actual.writeAck),
    totalBytes: vi.fn(actual.totalBytes),
    collectArtifactFiles: vi.fn(async () => ({ files: [] })),
    runCleanupScript: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
    waitForCompletion: vi.fn(async () => ({ type: 'exit' as const, exitCode: 0 })),
  };
});

function mockSocket(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

describe('Phase 4 toolchain_changed rejection (§1.7)', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
    vi.clearAllMocks();
  });

  it('fails terminal with toolchain_changed when activation path is missing at run time', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-toolchain-'));
    const socket = mockSocket();
    const missingToolPath = join(stateDir, 'missing-toolchain-bin');
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
      toolchainProfiles: [
        {
          id: 'rust-stable',
          kind: 'rust',
          version: '1.80.0',
          platform: 'windows-x64',
          activation: { type: 'path_prepend', path: missingToolPath },
          environment_fingerprint: 'fp-current',
        },
      ],
    });

    const projectPath = join(stateDir, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'main.rs'), 'fn main() {}');

    executor.handleLeaseOffer({
      attempt_id: 'att_tc',
      lease_id: 'lease_tc',
      lease_epoch: 1,
      job_id: 'job_tc',
      job_request: {
        client_request_id: 'req_tc',
        source: { project_root: projectPath, cwd: '.' },
        execution: { script: 'cargo build' },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_tc',
        content_id: 'cid_tc',
        size_bytes: 1,
        sha256: 'ab',
      },
      selected_toolchain_profiles: [
        {
          id: 'rust-stable',
          kind: 'rust',
          version: '1.80.0',
          platform: 'windows-x64',
          activation: { type: 'path_prepend', path: missingToolPath },
          environment_fingerprint: 'fp-current',
        },
      ],
      lease_ttl_seconds: 300,
    });

    const exe = executor as unknown as {
      currentPrepare: unknown;
      materializedProjectPath: string;
      prepareReady: boolean;
    };
    exe.currentPrepare = {
      source_mode: 'full',
      attempt_id: 'att_tc',
      lease_id: 'lease_tc',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    exe.materializedProjectPath = projectPath;
    exe.prepareReady = true;

    await executor.handleRunJob({
      attempt_id: 'att_tc',
      lease_id: 'lease_tc',
      lease_epoch: 1,
    });

    const exitFrame = socket.sent.find((f) => f.type === 'job_exit');
    expect(exitFrame?.payload).toMatchObject({
      outcome: 'failed',
      failure_category: 'toolchain_changed',
    });
    expect(String(exitFrame?.payload?.failure_message ?? '')).toMatch(/missing/i);
    expect(executor.isBusy()).toBe(false);
  });

  it('fails terminal with toolchain_changed when environment_fingerprint drifts', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-toolchain-'));
    const socket = mockSocket();
    const toolPath = join(stateDir, 'cargo.exe');
    await writeFile(toolPath, '');

    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
      toolchainProfiles: [
        {
          id: 'rust-stable',
          kind: 'rust',
          version: '1.80.0',
          platform: 'windows-x64',
          activation: { type: 'path_prepend', path: toolPath },
          environment_fingerprint: 'fp-current',
        },
      ],
    });

    const projectPath = join(stateDir, 'project');
    await mkdir(projectPath, { recursive: true });

    executor.handleLeaseOffer({
      attempt_id: 'att_fp',
      lease_id: 'lease_fp',
      lease_epoch: 1,
      job_id: 'job_fp',
      job_request: {
        client_request_id: 'req_fp',
        source: { project_root: projectPath, cwd: '.' },
        execution: { script: 'cargo build' },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_fp',
        content_id: 'cid_fp',
        size_bytes: 1,
        sha256: 'ab',
      },
      selected_toolchain_profiles: [
        {
          id: 'rust-stable',
          kind: 'rust',
          version: '1.80.0',
          platform: 'windows-x64',
          activation: { type: 'path_prepend', path: toolPath },
          environment_fingerprint: 'fp-stale-from-scheduler',
        },
      ],
      lease_ttl_seconds: 300,
    });

    const exe = executor as unknown as {
      currentPrepare: unknown;
      materializedProjectPath: string;
    };
    exe.currentPrepare = {
      source_mode: 'full',
      attempt_id: 'att_fp',
      lease_id: 'lease_fp',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    exe.materializedProjectPath = projectPath;

    await executor.handleRunJob({
      attempt_id: 'att_fp',
      lease_id: 'lease_fp',
      lease_epoch: 1,
    });

    const exitFrame = socket.sent.find((f) => f.type === 'job_exit');
    expect(exitFrame?.payload).toMatchObject({
      failure_category: 'toolchain_changed',
    });
    expect(String(exitFrame?.payload?.failure_message ?? '')).toMatch(/fingerprint mismatch/i);
  });
});
