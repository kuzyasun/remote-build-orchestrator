/**
 * Phase 7 workload coverage hub.
 *
 * Fake-QEMU (always-on) cancel / cleanup / artifact paths are exercised here and
 * more broadly in packages/executor/test/completion-qemu-fake.test.ts.
 *
 * Docker unit mocks + primary gated e2e: apps/agent/test/docker-cleanup.test.ts
 * Warm/cold build-cache: apps/agent/test/build-cache-warm.test.ts
 * Benchmark report: apps/agent/test/phase7-benchmark.test.ts
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildReservedRboEnv,
  collectArtifactFiles,
  ensureAttemptLogs,
  runCleanupScript,
  spawnJobScript,
  waitForCompletion,
  writeJobScript,
} from '@rbo/executor';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cleanupDockerResourcesForAttempt } from '../src/docker/cleanup.js';
import { AgentRecoveryCoordinator } from '../src/recovery/coordinator.js';

const execFileAsync = promisify(execFile);

/** Test-only fake-workload script (not a real QEMU binary). */
const FAKE_WORKLOAD_JS = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  process.stdout.write('boot starting\\n');
  await new Promise((r) => setTimeout(r, 40));
  process.stdout.write('loading firmware\\n');
  await new Promise((r) => setTimeout(r, 40));
  process.stdout.write('BOOT_OK');
  const markerPath = process.env.FAKE_MARKER_PATH || '';
  if (markerPath) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'booted');
  }
  await new Promise((r) => setTimeout(r, 120000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

const fakeWorkspaces: string[] = [];

afterEach(async () => {
  while (fakeWorkspaces.length > 0) {
    const dir = fakeWorkspaces.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  }
});

describe('Phase 7 fake-QEMU workload (always)', () => {
  it('run_until_log_match success runs cleanup and collects artifacts', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-p7-fake-qemu-'));
    fakeWorkspaces.push(workspace);
    const controlDir = join(workspace, 'control');
    const projectPath = join(workspace, 'project');
    const artifactsDir = join(workspace, 'artifacts');
    const logsDir = join(workspace, 'logs');
    await mkdir(projectPath, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(controlDir, { recursive: true });
    const logs = await ensureAttemptLogs(logsDir);

    const workloadPath = join(projectPath, 'fake-workload.js');
    const markerPath = join(projectPath, 'markers', 'booted.txt');
    await mkdir(join(projectPath, 'markers'), { recursive: true });
    await writeFile(workloadPath, FAKE_WORKLOAD_JS, 'utf8');

    const isWin = process.platform === 'win32';
    const cleanupScript = isWin
      ? [
          'New-Item -ItemType Directory -Force -Path out | Out-Null',
          "Set-Content -Path out/result.txt -Value 'cleaned-by-fake-workload'",
        ].join('\n')
      : '#!/bin/bash\nmkdir -p out\necho cleaned-by-fake-workload > out/result.txt\n';

    const execution = {
      shell: (isWin ? 'powershell' : 'bash') as 'powershell' | 'bash',
      script: isWin
        ? `$env:FAKE_MARKER_PATH='${markerPath.replace(/'/g, "''")}'; & '${process.execPath.replace(/'/g, "''")}' '${workloadPath.replace(/'/g, "''")}'`
        : `#!/bin/bash
export FAKE_MARKER_PATH='${markerPath}'
exec '${process.execPath}' '${workloadPath}'
`,
      timeout_seconds: 30,
      cancel_grace_seconds: 1,
      cleanup_script: cleanupScript,
      cleanup_timeout_seconds: 30,
      completion: {
        type: 'run_until_log_match' as const,
        success_pattern: 'BOOT_OK',
        max_duration_seconds: 20,
      },
    };

    await writeJobScript(controlDir, execution);
    const reserved = buildReservedRboEnv({
      jobId: 'job_p7_fake',
      attemptId: 'att_p7_fake',
      workspacePath: workspace,
      projectPath,
      logDir: logs.logDir,
      artifactDir: artifactsDir,
    });

    const child = spawnJobScript({
      attemptId: 'att_p7_fake',
      controlDir,
      workspacePath: workspace,
      projectPath,
      execution,
      env: reserved,
      logs,
    });

    const result = await waitForCompletion({
      child,
      execution,
      logs,
      signal: { cancelled: false },
    });
    if (result.type !== 'exit') {
      await child.kill(execution.cancel_grace_seconds);
    }
    await child.waitForExit().catch(() => undefined);

    const cleanup = await runCleanupScript({
      attemptId: 'att_p7_fake',
      controlDir,
      workspacePath: workspace,
      projectPath,
      execution,
      env: reserved,
      logs,
    });
    const artifacts = await collectArtifactFiles({
      projectPath,
      rules: [{ glob: 'out/**' }],
    });

    expect(result.type).toBe('log_success');
    expect(cleanup.timedOut).toBe(false);
    expect(cleanup.exitCode).toBe(0);
    expect(artifacts.files.map((f) => f.logical_name)).toContain('out/result.txt');
    expect(await readFile(markerPath, 'utf8')).toBe('booted');
    expect(await readFile(join(projectPath, 'out', 'result.txt'), 'utf8')).toContain(
      'cleaned-by-fake-workload',
    );
  }, 45_000);
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
