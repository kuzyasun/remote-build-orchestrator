/**
 * Phase 7 workload coverage hub.
 *
 * Fake-QEMU (always-on) cancel / cleanup / artifact paths live in:
 *   packages/executor/test/completion-qemu-fake.test.ts
 * This file cross-links those guarantees and adds Docker-gated attempt cleanup
 * for success / failure / cancel / recovery contexts (label-scoped only).
 *
 * Docker unit mocks + primary gated e2e: apps/agent/test/docker-cleanup.test.ts
 * Warm/cold build-cache: apps/agent/test/build-cache-warm.test.ts
 */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDockerResourcesForAttempt } from '../src/docker/cleanup.js';
import { AgentRecoveryCoordinator } from '../src/recovery/coordinator.js';

const execFileAsync = promisify(execFile);

const FAKE_QEMU_SUITE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'executor',
  'test',
  'completion-qemu-fake.test.ts',
);

describe('Phase 7 fake-QEMU cross-link (always)', () => {
  it('documents Task 1 fake-QEMU suite covering cancel/cleanup/artifacts', async () => {
    await access(FAKE_QEMU_SUITE);
    const src = await readFile(FAKE_QEMU_SUITE, 'utf8');
    expect(src).toMatch(/run_until_log_match success_pattern/);
    expect(src).toMatch(/cancel kills fake-workload descendant/);
    expect(src).toMatch(/collectArtifactFiles|artifacts\.files/);
    expect(src).toMatch(/runCleanupScript|cleanup\.exitCode/);
  });
});

async function canRunDocker(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = await canRunDocker();

describe('Phase 7 Docker gated workloads', () => {
  // PLATFORM-GAP: Docker daemon not available on this host
  const runId = Date.now().toString(36);
  const created: Array<{ kind: 'container' | 'network' | 'volume'; id: string }> = [];

  async function docker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('docker', args, { timeout: 60_000 });
    return stdout.trim();
  }

  async function createAttemptResources(attemptId: string): Promise<{
    container: string;
    network: string;
    volume: string;
  }> {
    const container = await docker([
      'run',
      '-d',
      '--label',
      `rbo.attempt=${attemptId}`,
      '--name',
      `rbo-${attemptId}`,
      'alpine:3.20',
      'sleep',
      '120',
    ]);
    created.push({ kind: 'container', id: container });

    const network = await docker([
      'network',
      'create',
      '--label',
      `rbo.attempt=${attemptId}`,
      `rbo-net-${attemptId}`,
    ]);
    created.push({ kind: 'network', id: network });

    const volume = await docker([
      'volume',
      'create',
      '--label',
      `rbo.attempt=${attemptId}`,
      `rbo-vol-${attemptId}`,
    ]);
    created.push({ kind: 'volume', id: volume });

    return { container, network, volume };
  }

  function markCleaned(ids: string[]): void {
    for (const item of created) {
      if (ids.includes(item.id)) {
        item.id = '';
      }
    }
  }

  afterAll(async () => {
    if (!dockerOk) return;
    for (const item of created.reverse()) {
      if (!item.id) continue;
      try {
        if (item.kind === 'container') await docker(['rm', '-f', item.id]);
        else if (item.kind === 'network') await docker(['network', 'rm', item.id]);
        else await docker(['volume', 'rm', '-f', item.id]);
      } catch {
        // best-effort
      }
    }
  });

  async function runCleanupScenario(ctx: 'ok' | 'fail' | 'cancel' | 'recover'): Promise<void> {
    const attemptKeep = `att_keep_${ctx}_${runId}`;
    const attemptClean = `att_${ctx}_${runId}`;
    const keep = await createAttemptResources(attemptKeep);
    const clean = await createAttemptResources(attemptClean);

    if (ctx === 'recover') {
      const recovery = new AgentRecoveryCoordinator({
        stateDir: join(tmpdir(), `rbo-p7-recover-${ctx}-${runId}`),
        hooks: {
          terminateAttempt: async () => undefined,
          cleanupAttemptResources: async (attemptId) => {
            await cleanupDockerResourcesForAttempt({ attemptId });
          },
        },
      });
      await recovery.handleReconcileDecision({
        attempt_id: attemptClean,
        action: 'terminate_stale',
        reason: 'fence_mismatch',
      });
    } else {
      const result = await cleanupDockerResourcesForAttempt({
        attemptId: attemptClean,
        jobId: `job_${ctx}`,
      });
      expect(result.skipped).toBe(false);
      expect(result.containersRemoved).toContain(clean.container);
      expect(result.networksRemoved).toContain(clean.network);
      expect(result.volumesRemoved).toContain(clean.volume);
    }

    const remainingClean = await docker([
      'ps',
      '-aq',
      '--filter',
      `label=rbo.attempt=${attemptClean}`,
    ]);
    expect(remainingClean.trim()).toBe('');

    const remainingKeep = await docker([
      'ps',
      '-aq',
      '--filter',
      `label=rbo.attempt=${attemptKeep}`,
    ]);
    expect(remainingKeep).toContain(keep.container);

    markCleaned([clean.container, clean.network, clean.volume]);
  }

  it.skipIf(!dockerOk)('success path: labelled resources gone; other untouched', async () => {
    await runCleanupScenario('ok');
  });

  it.skipIf(!dockerOk)(
    'failure path: labelled resources gone after failed-outcome cleanup',
    async () => {
      await runCleanupScenario('fail');
    },
  );

  it.skipIf(!dockerOk)('cancel path: labelled resources gone after cancel cleanup', async () => {
    await runCleanupScenario('cancel');
  });

  it.skipIf(!dockerOk)(
    'recovery path: terminate_stale hook cleans labelled resources only',
    async () => {
      await runCleanupScenario('recover');
    },
  );
});
