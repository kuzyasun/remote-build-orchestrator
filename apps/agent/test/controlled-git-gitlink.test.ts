import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { GitUrlAllowlist } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { checkoutOverlayGitlinkPins } from '../src/repos/controlled-git.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[], extraConfig: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync('git', [...extraConfig, ...args], {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

describe('checkoutOverlayGitlinkPins', () => {
  it('checks out pinned submodule commits detached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-agent-gitlink-pin-'));
    const subWorking = join(root, 'sub-working');
    const parent = join(root, 'parent');

    try {
      await mkdir(subWorking, { recursive: true });
      await mkdir(parent, { recursive: true });

      await runGit(subWorking, ['init']);
      await runGit(subWorking, ['config', 'user.email', 't@example.com']);
      await runGit(subWorking, ['config', 'user.name', 'T']);
      await writeFile(join(subWorking, 'file1.txt'), 'content1');
      await runGit(subWorking, ['add', 'file1.txt']);
      await runGit(subWorking, ['commit', '-m', 'c1']);
      const commit1 = await runGit(subWorking, ['rev-parse', 'HEAD']);

      await writeFile(join(subWorking, 'file2.txt'), 'content2');
      await runGit(subWorking, ['add', 'file2.txt']);
      await runGit(subWorking, ['commit', '-m', 'c2']);
      const commit2 = await runGit(subWorking, ['rev-parse', 'HEAD']);

      await runGit(parent, ['init']);
      await runGit(parent, ['config', 'user.email', 't@example.com']);
      await runGit(parent, ['config', 'user.name', 'T']);
      await runGit(
        parent,
        ['submodule', 'add', pathToFileURL(subWorking).href, 'vendor/lib'],
        ['-c', 'protocol.file.allow=always'],
      );

      const allowlist: GitUrlAllowlist = {
        schemes: ['file'],
        hosts: [],
        repository_prefixes: ['/'],
      };

      // Submodule currently at commit2, request checkout pin to commit1
      await checkoutOverlayGitlinkPins({
        projectPath: parent,
        pins: [{ path: 'vendor/lib', commit: commit1 }],
        allowlist,
      });

      const currentSubHead = await runGit(join(parent, 'vendor/lib'), ['rev-parse', 'HEAD']);
      expect(currentSubHead).toBe(commit1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
