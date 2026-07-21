import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { type DockerRunner, cleanupDockerResourcesForAttempt } from '../src/docker/cleanup.js';
import { AgentRecoveryCoordinator } from '../src/recovery/coordinator.js';
import { dockerIdListContains, dockerListOutputContains } from './helpers/docker-ids.js';

const execFileAsync = promisify(execFile);

type RunCall = { bin: string; args: string[] };

function createMockRunner(handlers: {
  listContainers?: string[];
  listNetworks?: string[];
  listVolumes?: string[];
  onRm?: (args: string[]) => void;
  missingBin?: boolean;
}): { run: DockerRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: DockerRunner = async (bin, args) => {
    calls.push({ bin, args });
    if (handlers.missingBin) {
      const err = new Error('spawn docker ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    const joined = args.join(' ');
    if (args[0] === 'ps' && args.includes('-aq')) {
      return { stdout: `${(handlers.listContainers ?? []).join('\n')}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'network' && args[1] === 'ls') {
      return { stdout: `${(handlers.listNetworks ?? []).join('\n')}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      return { stdout: `${(handlers.listVolumes ?? []).join('\n')}\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'rm' || joined.startsWith('network rm') || joined.startsWith('volume rm')) {
      handlers.onRm?.(args);
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { run, calls };
}

describe('cleanupDockerResourcesForAttempt (mocked docker CLI)', () => {
  it('removes only resources matching label=rbo.attempt=<attemptId>', async () => {
    const removed: string[][] = [];
    const { run, calls } = createMockRunner({
      listContainers: ['ctr_att_x'],
      listNetworks: ['net_att_x'],
      listVolumes: ['vol_att_x'],
      onRm: (args) => removed.push(args),
    });

    const result = await cleanupDockerResourcesForAttempt(
      { attemptId: 'att_x', jobId: 'job_1' },
      run,
    );

    expect(result.skipped).toBe(false);
    expect(result.containersRemoved).toEqual(['ctr_att_x']);
    expect(result.networksRemoved).toEqual(['net_att_x']);
    expect(result.volumesRemoved).toEqual(['vol_att_x']);

    const filters = calls
      .map((c) => c.args)
      .filter((args) => args.includes('--filter'))
      .map((args) => args[args.indexOf('--filter') + 1]);
    expect(filters.every((f) => f === 'label=rbo.attempt=att_x')).toBe(true);
    expect(filters.some((f) => f.includes('att_other'))).toBe(false);

    const allArgs = calls.flatMap((c) => c.args);
    expect(allArgs).not.toContain('system');
    expect(allArgs.join(' ')).not.toMatch(/\bprune\b/);
    expect(removed.some((a) => a.includes('ctr_att_other'))).toBe(false);
  });

  it('never issues system prune or unfiltered volume prune', async () => {
    const { run, calls } = createMockRunner({
      listContainers: [],
      listNetworks: [],
      listVolumes: [],
    });

    await cleanupDockerResourcesForAttempt({ attemptId: 'att_safe' }, run);

    const serialized = calls.map((c) => `${c.bin} ${c.args.join(' ')}`);
    expect(serialized.some((s) => s.includes('system prune'))).toBe(false);
    expect(serialized.some((s) => /volume\s+prune/.test(s))).toBe(false);
  });

  it('returns skipped when docker binary is missing (does not throw)', async () => {
    const { run } = createMockRunner({ missingBin: true });

    await expect(
      cleanupDockerResourcesForAttempt({ attemptId: 'att_missing' }, run),
    ).resolves.toEqual({
      containersRemoved: [],
      networksRemoved: [],
      volumesRemoved: [],
      skipped: true,
      reason: 'docker_unavailable',
    });
  });

  it('cleans containers then networks then volumes (order)', async () => {
    const phases: string[] = [];
    const { run } = createMockRunner({
      listContainers: ['c1'],
      listNetworks: ['n1'],
      listVolumes: ['v1'],
      onRm: (args) => {
        if (args[0] === 'rm') phases.push('container');
        else if (args[0] === 'network') phases.push('network');
        else if (args[0] === 'volume') phases.push('volume');
      },
    });

    await cleanupDockerResourcesForAttempt({ attemptId: 'att_order' }, run);
    expect(phases).toEqual(['container', 'network', 'volume']);
  });
});

describe('AgentRecoveryHooks.cleanupAttemptResources', () => {
  it('invokes cleanupAttemptResources on terminate_stale', async () => {
    const cleaned: string[] = [];
    const recovery = new AgentRecoveryCoordinator({
      stateDir: '/tmp/rbo-docker-cleanup-hook-test',
      hooks: {
        terminateAttempt: async () => undefined,
        cleanupAttemptResources: async (attemptId) => {
          cleaned.push(attemptId);
        },
      },
    });

    await recovery.handleReconcileDecision({
      attempt_id: 'att_stale',
      action: 'terminate_stale',
      reason: 'fence_mismatch',
    });

    expect(cleaned).toEqual(['att_stale']);
  });

  it('invokes cleanupAttemptResources on verified orphan cleanup', async () => {
    const cleaned: string[] = [];
    const recovery = new AgentRecoveryCoordinator({
      stateDir: '/tmp/rbo-docker-cleanup-orphan-test',
      hooks: {
        terminateAttempt: async () => undefined,
        cleanupAttemptResources: async (attemptId) => {
          cleaned.push(`orphan:${attemptId}`);
        },
      },
    });

    await recovery.cleanupVerifiedOrphan('att_orphan');
    expect(cleaned).toEqual(['orphan:att_orphan']);
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

describe('cleanupDockerResourcesForAttempt (real Docker)', () => {
  // PLATFORM-GAP: Docker daemon not available on this host
  const suffix = `rbo${Date.now().toString(36)}`;
  const attemptKeep = `att_keep_${suffix}`;
  const attemptClean = `att_clean_${suffix}`;
  const created: Array<{ kind: 'container' | 'network' | 'volume'; id: string }> = [];

  async function docker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('docker', args, { timeout: 60_000 });
    return stdout.trim();
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
        // best-effort teardown
      }
    }
  });

  it.skipIf(!dockerOk)(
    'removes labelled container/network/volume; leaves other attempt untouched',
    async () => {
      const ctrKeep = await docker([
        'run',
        '-d',
        '--label',
        `rbo.attempt=${attemptKeep}`,
        '--name',
        `rbo-${attemptKeep}`,
        'alpine:3.20',
        'sleep',
        '120',
      ]);
      created.push({ kind: 'container', id: ctrKeep });

      const ctrClean = await docker([
        'run',
        '-d',
        '--label',
        `rbo.attempt=${attemptClean}`,
        '--name',
        `rbo-${attemptClean}`,
        'alpine:3.20',
        'sleep',
        '120',
      ]);
      created.push({ kind: 'container', id: ctrClean });

      const netKeep = await docker([
        'network',
        'create',
        '--label',
        `rbo.attempt=${attemptKeep}`,
        `rbo-net-${attemptKeep}`,
      ]);
      created.push({ kind: 'network', id: netKeep });

      const netClean = await docker([
        'network',
        'create',
        '--label',
        `rbo.attempt=${attemptClean}`,
        `rbo-net-${attemptClean}`,
      ]);
      created.push({ kind: 'network', id: netClean });

      const volKeep = await docker([
        'volume',
        'create',
        '--label',
        `rbo.attempt=${attemptKeep}`,
        `rbo-vol-${attemptKeep}`,
      ]);
      created.push({ kind: 'volume', id: volKeep });

      const volClean = await docker([
        'volume',
        'create',
        '--label',
        `rbo.attempt=${attemptClean}`,
        `rbo-vol-${attemptClean}`,
      ]);
      created.push({ kind: 'volume', id: volClean });

      const result = await cleanupDockerResourcesForAttempt({ attemptId: attemptClean });

      expect(result.skipped).toBe(false);
      expect(dockerIdListContains(result.containersRemoved, ctrClean)).toBe(true);
      expect(dockerIdListContains(result.networksRemoved, netClean)).toBe(true);
      expect(dockerIdListContains(result.volumesRemoved, volClean)).toBe(true);

      const remainingCtr = await docker([
        'ps',
        '-aq',
        '--filter',
        `label=rbo.attempt=${attemptKeep}`,
      ]);
      expect(dockerListOutputContains(remainingCtr, ctrKeep)).toBe(true);

      const remainingNet = await docker([
        'network',
        'ls',
        '-q',
        '--filter',
        `label=rbo.attempt=${attemptKeep}`,
      ]);
      expect(dockerListOutputContains(remainingNet, netKeep)).toBe(true);

      const remainingVol = await docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=rbo.attempt=${attemptKeep}`,
      ]);
      expect(dockerListOutputContains(remainingVol, volKeep)).toBe(true);

      // Mark cleaned resources as already removed so afterAll does not fail loudly.
      for (const item of created) {
        if (item.id === ctrClean || item.id === netClean || item.id === volClean) {
          item.id = '';
        }
      }
    },
  );

  // Extended gated paths (success covered above; failure/cancel/recovery below).
  // Full scenario matrix also in apps/agent/test/qemu-docker-workloads.test.ts.

  it.skipIf(!dockerOk)(
    'failure/cancel/recovery contexts: same label filter; other attempt untouched',
    async () => {
      const contexts = ['fail', 'cancel', 'recover'] as const;
      const keepCtr = await docker([
        'run',
        '-d',
        '--label',
        `rbo.attempt=${attemptKeep}`,
        '--name',
        `rbo-keep-ctx-${suffix}`,
        'alpine:3.20',
        'sleep',
        '120',
      ]);
      created.push({ kind: 'container', id: keepCtr });

      for (const ctx of contexts) {
        const attemptId = `att_${ctx}_${suffix}`;
        const ctr = await docker([
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
        created.push({ kind: 'container', id: ctr });

        if (ctx === 'recover') {
          const recovery = new AgentRecoveryCoordinator({
            stateDir: '/tmp/rbo-docker-cleanup-recover-e2e',
            hooks: {
              terminateAttempt: async () => undefined,
              cleanupAttemptResources: async (id) => {
                await cleanupDockerResourcesForAttempt({ attemptId: id });
              },
            },
          });
          await recovery.cleanupVerifiedOrphan(attemptId);
        } else {
          const result = await cleanupDockerResourcesForAttempt({
            attemptId,
            jobId: `job_${ctx}`,
          });
          expect(result.skipped).toBe(false);
          expect(dockerIdListContains(result.containersRemoved, ctr)).toBe(true);
        }

        const remaining = await docker(['ps', '-aq', '--filter', `label=rbo.attempt=${attemptId}`]);
        expect(remaining.trim()).toBe('');

        for (const item of created) {
          if (item.id === ctr) item.id = '';
        }
      }

      const keepRemaining = await docker([
        'ps',
        '-aq',
        '--filter',
        `label=rbo.attempt=${attemptKeep}`,
      ]);
      expect(dockerListOutputContains(keepRemaining, keepCtr)).toBe(true);
    },
  );
});
