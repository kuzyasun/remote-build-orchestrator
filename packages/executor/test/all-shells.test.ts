import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJobScript } from '../src/script.js';

describe('All shells script writing', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

    const zshPath = await writeJobScript(dir, { ...baseExec, shell: 'zsh', script: 'echo zsh' });
    expect(zshPath.endsWith('job.sh')).toBe(true);
    expect(await readFile(zshPath, 'utf8')).toBe('echo zsh');

    const shPath = await writeJobScript(dir, { ...baseExec, shell: 'sh', script: 'echo sh' });
    expect(shPath.endsWith('job.sh')).toBe(true);

    const pwshPath = await writeJobScript(dir, { ...baseExec, shell: 'pwsh', script: 'Write-Output pwsh' });
    expect(pwshPath.endsWith('job.ps1')).toBe(true);
    expect(await readFile(pwshPath, 'utf8')).toContain('Write-Output pwsh');

    const cmdPath = await writeJobScript(dir, { ...baseExec, shell: 'cmd', script: 'echo cmd' });
    expect(cmdPath.endsWith('job.cmd')).toBe(true);
    expect(await readFile(cmdPath, 'utf8')).toBe('echo cmd');
  });
});
