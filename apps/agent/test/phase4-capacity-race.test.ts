/**
 * Phase 4 §1.7 — one active job slot: second lease/prepare/run rejected while slot held.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import { DEFAULT_REPO_CACHE_CONFIG } from '../src/repos/mirror.js';

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

function baseOffer(attemptId: string, leaseId: string) {
  return {
    attempt_id: attemptId,
    lease_id: leaseId,
    lease_epoch: 1,
    job_id: `job_${attemptId}`,
    job_request: {
      client_request_id: `req_${attemptId}`,
      source: { project_root: 'C:/proj', cwd: '.' },
      execution: { script: 'echo hi' },
    },
    snapshot_metadata: {
      snapshot_id: 'snp_1',
      content_id: 'cid',
      size_bytes: 1,
      sha256: 'ab',
    },
    lease_ttl_seconds: 300,
  };
}

describe('Phase 4 one-slot race (§1.7)', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects a second lease_offer while the single job slot is held', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-one-slot-'));
    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    executor.handleLeaseOffer(baseOffer('att_1', 'lease_1'));
    expect(executor.isBusy()).toBe(true);
    expect(socket.sent.some((f) => f.type === 'lease_accept')).toBe(true);

    executor.handleLeaseOffer(baseOffer('att_2', 'lease_2'));

    const reject = socket.sent.find((f) => f.type === 'lease_reject');
    expect(reject?.payload).toMatchObject({
      attempt_id: 'att_2',
      reason: 'Agent capacity limit reached (1 active job max)',
    });
    expect(socket.sent.filter((f) => f.type === 'lease_accept')).toHaveLength(1);
  });

  it('ignores prepare_source and run_job for a different attempt while slot is held', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-one-slot-'));
    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    executor.handleLeaseOffer(baseOffer('att_1', 'lease_1'));

    await executor.handlePrepareSource({
      source_mode: 'full',
      attempt_id: 'att_2',
      lease_id: 'lease_2',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    });

    await executor.handleRunJob({
      attempt_id: 'att_2',
      lease_id: 'lease_2',
      lease_epoch: 1,
    });

    expect(socket.sent.some((f) => f.type === 'source_ready')).toBe(false);
    expect(socket.sent.some((f) => f.type === 'job_started')).toBe(false);
    expect(socket.sent.some((f) => f.type === 'job_exit')).toBe(false);
    expect(executor.isBusy()).toBe(true);
  });
});
