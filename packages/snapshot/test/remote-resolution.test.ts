import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitListRemoteFetchUrls,
  resolveAllowlistedRemoteUrl,
  resolveRepositoryRemoteUrl,
} from '../src/git-status.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

describe('repository remote resolution', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function initRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'rbo-remote-'));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'test@example.com']);
    await runGit(root, ['config', 'user.name', 'Test']);
    await writeFile(join(root, 'README.md'), 'x\n');
    await runGit(root, ['add', '.']);
    await runGit(root, ['commit', '-m', 'init']);
    return root;
  }

  it('lists fetch remotes and prefers origin when present', async () => {
    const root = await initRepo();
    await runGit(root, ['remote', 'add', 'Github', 'git@github.com:acme/app.git']);
    await runGit(root, ['remote', 'add', 'origin', 'git@github.com:acme/canonical.git']);

    const remotes = await gitListRemoteFetchUrls(root);
    expect(remotes.map((r) => r.name).sort()).toEqual(['Github', 'origin']);
    await expect(resolveRepositoryRemoteUrl(root)).resolves.toBe(
      'git@github.com:acme/canonical.git',
    );
  });

  it('falls back to a non-origin remote when origin is absent', async () => {
    const root = await initRepo();
    await runGit(root, ['remote', 'add', 'Github', 'git@github.com:kuzyasun/DTrackerInternal.git']);

    await expect(resolveRepositoryRemoteUrl(root)).resolves.toBe(
      'git@github.com:kuzyasun/DTrackerInternal.git',
    );
  });

  it('picks any allowlisted remote, not only origin', async () => {
    const root = await initRepo();
    await runGit(root, ['remote', 'add', 'Github', 'git@github.com:kuzyasun/DTrackerInternal.git']);
    await runGit(root, ['remote', 'add', 'evil', 'git@evil.example/not-allowed.git']);

    const allowlist = {
      schemes: ['ssh', 'https'],
      hosts: ['github.com'],
    };
    await expect(resolveAllowlistedRemoteUrl(root, allowlist)).resolves.toBe(
      'git@github.com:kuzyasun/DTrackerInternal.git',
    );
  });

  it('prefers allowlisted origin over other allowlisted remotes', async () => {
    const root = await initRepo();
    await runGit(root, ['remote', 'add', 'Github', 'https://github.com/acme/other.git']);
    await runGit(root, ['remote', 'add', 'origin', 'https://github.com/acme/main.git']);

    const allowlist = {
      schemes: ['https'],
      hosts: ['github.com'],
    };
    await expect(resolveAllowlistedRemoteUrl(root, allowlist)).resolves.toBe(
      'https://github.com/acme/main.git',
    );
  });
});
