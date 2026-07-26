import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POWERSHELL_JOB_PRELUDE, writeJobScript } from '../src/script.js';

describe('PowerShell job prelude', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('seeds $LASTEXITCODE so GUI-native unset does not false-exit', () => {
    expect(POWERSHELL_JOB_PRELUDE).toContain('$global:LASTEXITCODE = 0');
  });

  it('prefixes powershell job and cleanup scripts with the prelude', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-ps-prelude-'));
    dirs.push(dir);
    const jobPath = await writeJobScript(dir, {
      shell: 'powershell',
      script: 'eim run "idf.py --version"\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n',
      timeout_seconds: 60,
      cancel_grace_seconds: 10,
      cleanup_timeout_seconds: 60,
      tty: false,
      env: {},
      completion: { type: 'run_to_exit' },
    });
    const jobBody = await readFile(jobPath, 'utf8');
    expect(jobBody.startsWith(POWERSHELL_JOB_PRELUDE)).toBe(true);
    expect(jobBody).toContain('eim run "idf.py --version"');

    const cleanupPath = await writeJobScript(
      dir,
      {
        shell: 'powershell',
        script: 'unused',
        cleanup_script: 'Write-Output cleanup',
        timeout_seconds: 60,
        cancel_grace_seconds: 10,
        cleanup_timeout_seconds: 60,
        tty: false,
        env: {},
        completion: { type: 'run_to_exit' },
      },
      'cleanup.ps1',
    );
    const cleanupBody = await readFile(cleanupPath, 'utf8');
    expect(cleanupBody.startsWith(POWERSHELL_JOB_PRELUDE)).toBe(true);
    expect(cleanupBody).toContain('Write-Output cleanup');
  });

  it('does not prefix bash scripts with the PowerShell prelude', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-bash-prelude-'));
    dirs.push(dir);
    const p = await writeJobScript(dir, {
      shell: 'bash',
      script: 'echo hi',
      timeout_seconds: 60,
      cancel_grace_seconds: 10,
      cleanup_timeout_seconds: 60,
      tty: false,
      env: {},
      completion: { type: 'run_to_exit' },
    });
    const body = await readFile(p, 'utf8');
    expect(body.startsWith(POWERSHELL_JOB_PRELUDE)).toBe(false);
    expect(body).toContain('echo hi');
  });
});
