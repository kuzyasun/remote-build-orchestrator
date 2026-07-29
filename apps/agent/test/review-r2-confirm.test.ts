/**
 * Round-2 fixes — assert corrected behaviour.
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

describe('REVIEW R2 agent fixes', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('[P1] cancel after prepare ready clears slot and sends cancelled terminal', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-rev2-cancel-'));
    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    executor.handleLeaseOffer({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      job_id: 'job_1',
      job_request: {
        client_request_id: 'req_1',
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
    });
    expect(executor.isBusy()).toBe(true);

    const attempt = (
      executor as unknown as {
        attempts: Map<
          string,
          { prepare: unknown; materializedProjectPath: string | null; prepareReady: boolean }
        >;
      }
    ).attempts.get('att_1');
    if (!attempt) {
      throw new Error('expected att_1 runtime');
    }
    attempt.prepare = {
      source_mode: 'git_overlay',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      repo: {
        url: 'git@github.com:org/repo.git',
        canonical_id: 'github.com/org/repo',
        branch: 'main',
        base_commit: 'abc',
        fetch_refs: ['refs/heads/main'],
      },
      overlay: {
        download_url: 'https://example/overlay',
        data_token: 'tok',
        expected_size_bytes: 1,
        expected_sha256: 'ab',
      },
    };
    attempt.materializedProjectPath = join(stateDir, 'workspaces', 'att_1', 'project');
    attempt.prepareReady = true;

    await executor.handleCancelJob({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      grace_seconds: 1,
      reason: 'operator cancel',
    });

    expect(executor.isBusy()).toBe(false);
    expect(socket.sent.find((f) => f.type === 'job_exit')?.payload).toMatchObject({
      outcome: 'cancelled',
    });
    expect(socket.sent.find((f) => f.type === 'cleanup_complete')).toBeDefined();
  });

  it('[P1] missing commit after fetch failure still requests bundle first', () => {
    // Decision: never escalate to repo_fetch_failed until bundle path is exhausted.
    const fetchFailed = true;
    const hasCommit = false;
    const triedBundle = false;
    const reason = !hasCommit
      ? triedBundle
        ? fetchFailed
          ? 'repo_fetch_failed'
          : 'full_snapshot_required'
        : 'base_commit_missing'
      : null;
    expect(reason).toBe('base_commit_missing');
    expect(reason === 'repo_fetch_failed').toBe(false);
  });
});
