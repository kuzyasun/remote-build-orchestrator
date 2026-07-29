import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAttemptLogs } from '../src/logs.js';
import { POSIX_JOB_CONTROL_PRELUDE, spawnJobScript, writeJobScript } from '../src/script.js';

const execFileAsync = promisify(execFile);

async function shellAvailable(shell: string): Promise<boolean> {
  try {
    await execFileAsync('/bin/sh', ['-c', `command -v ${shell}`]);
    return true;
  } catch {
    return false;
  }
}

describe('All shells script writing', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // The prelude shifts every line number in the user's script, which surfaces in
  // their own `job.sh: line N:` diagnostics. Keep that offset at exactly 1.
  it('offsets user script line numbers by no more than one line', () => {
    expect(POSIX_JOB_CONTROL_PRELUDE.endsWith('\n')).toBe(true);
    expect(POSIX_JOB_CONTROL_PRELUDE.trimEnd()).not.toContain('\n');
  });

  it('writes appropriate script extensions for bash, zsh, sh, powershell, pwsh, cmd, direct', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-shells-test-'));
    dirs.push(dir);

    const baseExec = {
      timeout_seconds: 60,
      cancel_grace_seconds: 10,
      cleanup_timeout_seconds: 60,
      tty: false,
      env: {},
      completion: { type: 'run_to_exit' as const },
    };

    // zsh must NOT get the job-control prelude: `set -m` without a controlling
    // tty is fatal in zsh and would abort every zsh job outright.
    const zshPath = await writeJobScript(dir, { ...baseExec, shell: 'zsh', script: 'echo zsh' });
    expect(zshPath.endsWith('job.sh')).toBe(true);
    expect(await readFile(zshPath, 'utf8')).toBe('echo zsh');

    const shPath = await writeJobScript(dir, { ...baseExec, shell: 'sh', script: 'echo sh' });
    expect(shPath.endsWith('job.sh')).toBe(true);
    expect(await readFile(shPath, 'utf8')).toBe(`${POSIX_JOB_CONTROL_PRELUDE}echo sh`);

    const bashPath = await writeJobScript(dir, { ...baseExec, shell: 'bash', script: 'echo bash' });
    expect(bashPath.endsWith('job.sh')).toBe(true);
    expect(await readFile(bashPath, 'utf8')).toBe(`${POSIX_JOB_CONTROL_PRELUDE}echo bash`);

    const cleanupShPath = await writeJobScript(
      dir,
      { ...baseExec, shell: 'bash', script: 'echo main', cleanup_script: 'echo cleaning' },
      'cleanup.sh',
    );
    expect(await readFile(cleanupShPath, 'utf8')).toBe(`${POSIX_JOB_CONTROL_PRELUDE}echo cleaning`);

    const pwshPath = await writeJobScript(dir, {
      ...baseExec,
      shell: 'pwsh',
      script: 'Write-Output pwsh',
    });
    expect(pwshPath.endsWith('job.ps1')).toBe(true);
    expect(await readFile(pwshPath, 'utf8')).toContain('Write-Output pwsh');

    const cmdPath = await writeJobScript(dir, { ...baseExec, shell: 'cmd', script: 'echo cmd' });
    expect(cmdPath.endsWith('job.cmd')).toBe(true);
    expect(await readFile(cmdPath, 'utf8')).toBe('echo cmd');
  });
});

// Asserting only on written script *content* is what let a fatal `set -m`
// regression ship for zsh (the prelude aborted the script before line 1 ran).
// These actually execute each POSIX shell and require the body to have run.
describe('POSIX shells actually execute with the injected prelude', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
    );
  });

  for (const shell of ['bash', 'sh', 'zsh'] as const) {
    it.skipIf(process.platform === 'win32')(
      `runs a ${shell} job body to completion and preserves its exit code`,
      async () => {
        if (!(await shellAvailable(shell))) {
          return;
        }
        const workspace = await mkdtemp(join(tmpdir(), `rbo-exec-${shell}-`));
        dirs.push(workspace);
        const controlDir = join(workspace, 'control');
        const logs = await ensureAttemptLogs(join(workspace, 'logs'));

        // Backgrounds a job and exits non-zero, so we assert both that the body
        // ran at all and that the real exit code survives the prelude.
        const script = 'sleep 0.2 &\necho MARKER_BODY_RAN\nwait\nexit 3\n';
        const execution = {
          shell,
          script,
          timeout_seconds: 60,
          cancel_grace_seconds: 5,
          cleanup_timeout_seconds: 30,
        };
        await writeJobScript(controlDir, execution);
        const child = spawnJobScript({
          attemptId: `att_${shell}`,
          controlDir,
          workspacePath: workspace,
          projectPath: workspace,
          execution,
          env: {},
          logs,
        });

        let out = '';
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString();
        });
        const result = await child.waitForExit();

        expect(out).toContain('MARKER_BODY_RAN');
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(3);
      },
      30_000,
    );
  }
});
