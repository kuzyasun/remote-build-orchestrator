/**
 * §1.7 — one active job slot: second lease/prepare/run rejected while slot held.
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

describe('Single job-slot lease capacity race (§1.7)', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects a second lease_offer while the single job slot is held', async () => {
    // Why calling handleLeaseOffer twice back-to-back (rather than via Promise.all or two
    // interleaved async tasks) genuinely proves the one-slot invariant, not just a sequential
    // happy path: handleLeaseOffer (apps/agent/src/executor/index.ts) is fully synchronous from
    // its isBusy() admission check through setting `this.activeAttemptId` — there is no `await`
    // anywhere in between. Node's single-threaded event loop guarantees the first call's admission
    // check-and-commit runs to completion before a second call's code executes at all, for any
    // caller (including two real lease_offer WS frames arriving back-to-back on the same socket,
    // which Node still dispatches as two separate, non-overlapping 'message' event handler calls).
    // There is no interleaving window here to "race" — unlike, say, the Controller's scheduler
    // admission (a real SQL COUNT-based check against concurrent async dispatches), which is where
    // an actual race would need to be tested. Wrapping these two calls in Promise.all would test
    // nothing different, since neither call ever yields the event loop.
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
    // The held slot still belongs to the first attempt, not silently swapped to the rejected one.
    expect(executor.isBusy()).toBe(true);
  });

  it('rejects a burst of many concurrent-looking offers, keeping exactly the first slot holder', async () => {
    // Same synchronous-admission guarantee as above, exercised with more than two contenders and
    // fired from a single loop (the closest a same-process test gets to "many arrive at once")
    // to rule out an off-by-one in the busy-check surviving only a single extra offer.
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-one-slot-burst-'));
    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    const contenders = Array.from({ length: 8 }, (_, i) => `att_burst_${i}`);
    for (const attemptId of contenders) {
      executor.handleLeaseOffer(baseOffer(attemptId, `lease_${attemptId}`));
    }

    const accepted = socket.sent.filter((f) => f.type === 'lease_accept');
    const rejected = socket.sent.filter((f) => f.type === 'lease_reject');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(contenders.length - 1);
    expect((accepted[0]?.payload as { attempt_id: string }).attempt_id).toBe(contenders[0]);
    expect(
      rejected.every((f) => (f.payload as { attempt_id: string }).attempt_id !== contenders[0]),
    ).toBe(true);
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
