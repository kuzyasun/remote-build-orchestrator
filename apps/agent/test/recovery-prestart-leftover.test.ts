import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProcessIdentity } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import {
  attemptMetadataPath,
  readAttemptMetadata,
  writeAttemptMetadata,
} from '../src/recovery/attempt-metadata.js';
import { AgentRecoveryCoordinator } from '../src/recovery/coordinator.js';
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

describe('pre-start leftovers without process_identity', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('discards accepted metadata with null identity instead of sending recovery_report', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-prestart-leftover-'));
    const attemptId = 'att_unfenced';
    writeAttemptMetadata(stateDir, {
      attempt_id: attemptId,
      job_id: 'job_unfenced',
      lease_id: 'lease_unfenced',
      lease_epoch: 1,
      process_identity: null,
      status: 'accepted',
      workspace_path: join(stateDir, 'workspaces', attemptId),
      spool_dir: join(stateDir, 'logs', attemptId),
      risk_level: 'safe',
      updated_at: new Date().toISOString(),
    });

    const terminated: string[] = [];
    const cleaned: string[] = [];
    const recovery = new AgentRecoveryCoordinator({
      stateDir,
      hooks: {
        terminateAttempt: async (id) => {
          terminated.push(id);
        },
        cleanupAttemptResources: async (id) => {
          cleaned.push(id);
        },
      },
    });
    const socket = mockSocket();
    recovery.attachSocket(socket);
    await recovery.reportAll();

    expect(socket.sent.filter((frame) => frame.type === 'recovery_report')).toHaveLength(0);
    expect(terminated).toEqual([attemptId]);
    expect(cleaned).toEqual([attemptId]);
    expect(existsSync(attemptMetadataPath(stateDir, attemptId))).toBe(false);
    expect(readAttemptMetadata(stateDir, attemptId)).toBeNull();
  });

  it('treats empty process_identity the same as missing', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-prestart-empty-'));
    const attemptId = 'att_empty_identity';
    writeAttemptMetadata(stateDir, {
      attempt_id: attemptId,
      job_id: 'job_empty',
      lease_id: 'lease_empty',
      lease_epoch: 1,
      process_identity: '',
      status: 'orphaned',
      workspace_path: join(stateDir, 'workspaces', attemptId),
      spool_dir: join(stateDir, 'logs', attemptId),
      risk_level: 'safe',
      updated_at: new Date().toISOString(),
    });

    const recovery = new AgentRecoveryCoordinator({
      stateDir,
      hooks: { terminateAttempt: async () => undefined },
    });
    const socket = mockSocket();
    recovery.attachSocket(socket);
    await recovery.reportAll();

    expect(socket.sent.filter((frame) => frame.type === 'recovery_report')).toHaveLength(0);
    expect(existsSync(attemptMetadataPath(stateDir, attemptId))).toBe(false);
  });

  it('still reports attempts that have a process identity', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-prestart-fenced-'));
    const attemptId = 'att_fenced';
    const identity = formatProcessIdentity(42, 1_700_000_000_000);
    writeAttemptMetadata(stateDir, {
      attempt_id: attemptId,
      job_id: 'job_fenced',
      lease_id: 'lease_fenced',
      lease_epoch: 1,
      process_identity: identity,
      status: 'orphaned',
      workspace_path: join(stateDir, 'workspaces', attemptId),
      spool_dir: join(stateDir, 'logs', attemptId),
      risk_level: 'safe',
      updated_at: new Date().toISOString(),
    });

    const recovery = new AgentRecoveryCoordinator({
      stateDir,
      hooks: { terminateAttempt: async () => undefined },
    });
    const socket = mockSocket();
    recovery.attachSocket(socket);
    await recovery.reportAll();

    const reports = socket.sent.filter((frame) => frame.type === 'recovery_report');
    expect(reports).toHaveLength(1);
    expect((reports[0]?.payload as { process_identity?: string }).process_identity).toBe(identity);
    expect(existsSync(attemptMetadataPath(stateDir, attemptId))).toBe(true);
  });

  it('removes accepted metadata when prepare_source fails before spawn', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-prepare-fail-meta-'));
    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    const attemptId = 'att_prepare_fail';
    executor.handleLeaseOffer({
      attempt_id: attemptId,
      lease_id: 'lease_prepare_fail',
      lease_epoch: 1,
      job_id: `job_${attemptId}`,
      job_request: {
        client_request_id: `req_${attemptId}`,
        source: { project_root: 'C:/proj', cwd: '.' },
        execution: { script: 'true' },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_1',
        content_id: 'cid',
        size_bytes: 1,
        sha256: 'ab',
      },
      lease_ttl_seconds: 300,
    });
    expect(readAttemptMetadata(stateDir, attemptId)?.process_identity).toBeNull();
    expect(readAttemptMetadata(stateDir, attemptId)?.status).toBe('accepted');

    await executor.handlePrepareSource({
      attempt_id: attemptId,
      lease_id: 'lease_prepare_fail',
      lease_epoch: 1,
      source_mode: 'full',
      download_url: 'https://127.0.0.1/missing',
      data_token: 'tok',
      expected_size_bytes: 0,
      expected_sha256: 'ab',
    });

    expect(socket.sent.some((frame) => frame.type === 'job_exit')).toBe(true);
    await expect.poll(() => readAttemptMetadata(stateDir, attemptId)).toBeNull();
  });
});
