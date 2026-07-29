import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectArtifactFiles } from '../src/artifacts.js';
import { waitForCompletion } from '../src/completion.js';
import { ensureAttemptLogs } from '../src/logs.js';
import { buildReservedRboEnv } from '../src/runtime-env.js';
import { runCleanupScript, spawnJobScript, writeJobScript } from '../src/script.js';

/** Test-only fake-workload script (not a real QEMU binary). */
const FAKE_WORKLOAD_JS = `#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mode = process.env.FAKE_MODE || 'success';
const markerPath = process.env.FAKE_MARKER_PATH || '';
const childPidPath = process.env.FAKE_CHILD_PID_PATH || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (mode === 'spawn_child') {
    // Stay in parent process group so cancel/tree-kill can reap the descendant.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (childPidPath) {
      fs.writeFileSync(childPidPath, String(child.pid));
    }
    process.stdout.write('CHILD_SPAWNED\\n');
    await sleep(120000);
    return;
  }

  if (mode === 'failure') {
    process.stdout.write('boot starting\\n');
    await sleep(50);
    process.stdout.write('BOOT_FAIL\\n');
    await sleep(120000);
    return;
  }

  if (mode === 'duration') {
    let i = 0;
    while (true) {
      process.stdout.write('tick ' + i + '\\n');
      i += 1;
      await sleep(100);
    }
  }

  // success (default): progressive lines, success marker without trailing newline
  process.stdout.write('boot starting\\n');
  await sleep(50);
  process.stdout.write('loading firmware\\n');
  await sleep(50);
  process.stdout.write('BOOT_OK');
  if (markerPath) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'booted');
  }
  await sleep(120000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

const workspaces: string[] = [];

afterEach(async () => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  }
});

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createHarness(input: {
  fakeMode: string;
  timeoutSeconds: number;
  cancelGraceSeconds?: number;
  completion: {
    type: 'run_to_exit' | 'run_for_duration' | 'run_until_log_match';
    duration_seconds?: number;
    success_pattern?: string;
    failure_pattern?: string;
    max_duration_seconds?: number;
  };
  cleanupScript?: string;
  artifactGlob?: string;
}) {
  const workspace = await mkdtemp(join(tmpdir(), 'rbo-qemu-fake-'));
  workspaces.push(workspace);
  const controlDir = join(workspace, 'control');
  const projectPath = join(workspace, 'project');
  const artifactsDir = join(workspace, 'artifacts');
  const logsDir = join(workspace, 'logs');
  await mkdir(projectPath, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(controlDir, { recursive: true });
  const logs = await ensureAttemptLogs(logsDir);

  const workloadPath = join(projectPath, 'fake-workload.js');
  await writeFile(workloadPath, FAKE_WORKLOAD_JS, 'utf8');
  const markerPath = join(projectPath, 'markers', 'booted.txt');
  const childPidPath = join(projectPath, 'markers', 'child.pid');
  await mkdir(join(projectPath, 'markers'), { recursive: true });

  const isWin = process.platform === 'win32';
  const cleanupScript =
    input.cleanupScript ??
    (isWin
      ? [
          'New-Item -ItemType Directory -Force -Path out | Out-Null',
          "Set-Content -Path out/result.txt -Value 'cleaned-by-fake-workload'",
        ].join('\n')
      : '#!/bin/bash\nmkdir -p out\necho cleaned-by-fake-workload > out/result.txt\n');

  const execution = {
    shell: (isWin ? 'powershell' : 'bash') as 'powershell' | 'bash',
    script: isWin
      ? `$env:FAKE_MODE='${input.fakeMode}'; $env:FAKE_MARKER_PATH='${markerPath.replace(/'/g, "''")}'; $env:FAKE_CHILD_PID_PATH='${childPidPath.replace(/'/g, "''")}'; & '${process.execPath.replace(/'/g, "''")}' '${workloadPath.replace(/'/g, "''")}'`
      : `#!/bin/bash
export FAKE_MODE='${input.fakeMode}'
export FAKE_MARKER_PATH='${markerPath}'
export FAKE_CHILD_PID_PATH='${childPidPath}'
exec '${process.execPath}' '${workloadPath}'
`,
    timeout_seconds: input.timeoutSeconds,
    cancel_grace_seconds: input.cancelGraceSeconds ?? 1,
    cleanup_script: cleanupScript,
    cleanup_timeout_seconds: 30,
    completion: input.completion as never,
  };

  await writeJobScript(controlDir, execution);

  const reserved = buildReservedRboEnv({
    jobId: 'job_fake_qemu',
    attemptId: 'att_fake_qemu',
    workspacePath: workspace,
    projectPath,
    logDir: logs.logDir,
    artifactDir: artifactsDir,
  });

  const child = spawnJobScript({
    attemptId: 'att_fake_qemu',
    controlDir,
    workspacePath: workspace,
    projectPath,
    execution,
    env: reserved,
    logs,
  });

  return {
    workspace,
    controlDir,
    projectPath,
    artifactsDir,
    logs,
    execution,
    child,
    markerPath,
    childPidPath,
    artifactGlob: input.artifactGlob ?? 'out/**',
  };
}

async function finishLikeAgent(harness: Awaited<ReturnType<typeof createHarness>>): Promise<{
  result: Awaited<ReturnType<typeof waitForCompletion>>;
  cleanup: { exitCode: number | null; timedOut: boolean };
  artifacts: Awaited<ReturnType<typeof collectArtifactFiles>>;
}> {
  const signal = { cancelled: false };
  const result = await waitForCompletion({
    child: harness.child,
    execution: harness.execution,
    logs: harness.logs,
    signal,
  });

  if (result.type !== 'exit') {
    await harness.child.kill(harness.execution.cancel_grace_seconds);
  }
  await harness.child.waitForExit().catch(() => undefined);

  const cleanup = await runCleanupScript({
    attemptId: 'att_fake_qemu',
    controlDir: harness.controlDir,
    workspacePath: harness.workspace,
    projectPath: harness.projectPath,
    execution: harness.execution,
    env: buildReservedRboEnv({
      jobId: 'job_fake_qemu',
      attemptId: 'att_fake_qemu',
      workspacePath: harness.workspace,
      projectPath: harness.projectPath,
      logDir: harness.logs.logDir,
      artifactDir: harness.artifactsDir,
    }),
    logs: harness.logs,
  });

  const artifacts = await collectArtifactFiles({
    projectPath: harness.projectPath,
    rules: [{ glob: harness.artifactGlob }],
  });

  return { result, cleanup, artifacts };
}

describe('fake-workload completion policies (QEMU-style)', () => {
  it('run_until_log_match success_pattern stops, runs cleanup, collects artifact', async () => {
    const harness = await createHarness({
      fakeMode: 'success',
      timeoutSeconds: 30,
      completion: {
        type: 'run_until_log_match',
        success_pattern: 'BOOT_OK',
        max_duration_seconds: 20,
      },
    });

    const { result, cleanup, artifacts } = await finishLikeAgent(harness);

    expect(result.type).toBe('log_success');
    expect(cleanup.timedOut).toBe(false);
    expect(cleanup.exitCode).toBe(0);
    expect(artifacts.files.map((f) => f.logical_name)).toContain('out/result.txt');
    const content = await readFile(join(harness.projectPath, 'out', 'result.txt'), 'utf8');
    expect(content).toContain('cleaned-by-fake-workload');
  }, 45_000);

  it('failure_pattern yields log_failure completion result', async () => {
    const harness = await createHarness({
      fakeMode: 'failure',
      timeoutSeconds: 30,
      completion: {
        type: 'run_until_log_match',
        success_pattern: 'BOOT_OK',
        failure_pattern: 'BOOT_FAIL',
        max_duration_seconds: 20,
      },
    });

    const { result } = await finishLikeAgent(harness);
    expect(result.type).toBe('log_failure');
  }, 45_000);

  it('run_for_duration ends after duration without GNU timeout or TTY', async () => {
    const harness = await createHarness({
      fakeMode: 'duration',
      timeoutSeconds: 30,
      completion: {
        type: 'run_for_duration',
        duration_seconds: 1,
      },
    });

    const started = Date.now();
    const { result } = await finishLikeAgent(harness);
    const elapsedMs = Date.now() - started;

    expect(result.type).toBe('duration_complete');
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 45_000);

  it('hard timeout_seconds wins over longer duration policy', async () => {
    const harness = await createHarness({
      fakeMode: 'duration',
      timeoutSeconds: 1,
      completion: {
        type: 'run_for_duration',
        duration_seconds: 30,
      },
    });

    const { result } = await finishLikeAgent(harness);
    expect(result.type).toBe('timeout');
  }, 45_000);

  it('cancel kills fake-workload descendant process', async () => {
    const harness = await createHarness({
      fakeMode: 'spawn_child',
      timeoutSeconds: 60,
      cancelGraceSeconds: 1,
      completion: { type: 'run_to_exit' },
    });

    // Wait until child pid file appears
    let grandchildPid = 0;
    for (let i = 0; i < 50; i++) {
      try {
        const raw = await readFile(harness.childPidPath, 'utf8');
        grandchildPid = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(grandchildPid) && grandchildPid > 0) {
          break;
        }
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(grandchildPid).toBeGreaterThan(0);
    expect(await pidAlive(grandchildPid)).toBe(true);

    await harness.child.kill(1);
    await harness.child.waitForExit();
    await new Promise((r) => setTimeout(r, 800));

    expect(await pidAlive(harness.child.pid)).toBe(false);
    // On Windows, ManagedChildProcess uses taskkill /T. On Unix, process-group kill.
    // PLATFORM-GAP: if a host fails tree-kill for this fake-workload, skip rather than soft-pass.
    expect(await pidAlive(grandchildPid)).toBe(false);
  }, 45_000);

  it('log match succeeds without trailing newline in the success chunk', async () => {
    const harness = await createHarness({
      fakeMode: 'success',
      timeoutSeconds: 30,
      completion: {
        type: 'run_until_log_match',
        success_pattern: 'BOOT_OK',
        max_duration_seconds: 20,
      },
    });

    const { result } = await finishLikeAgent(harness);
    expect(result.type).toBe('log_success');

    const stdout = await readFile(harness.logs.stdoutPath, 'utf8');
    expect(stdout.includes('BOOT_OK')).toBe(true);
    // Success chunk itself has no trailing newline after BOOT_OK (may be followed by later data)
    expect(stdout).toMatch(/BOOT_OK(?!\n)/);
  }, 45_000);
});
