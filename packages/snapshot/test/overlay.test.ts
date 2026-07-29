import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { captureGitOverlaySnapshot } from '../src/capture.js';
import { gitStatusPorcelainV2 } from '../src/git-status.js';
import { applyGitOverlay } from '../src/materialize.js';
import { computeOverlayPlan } from '../src/overlay.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe('Overlay plan + apply', () => {
  it('plans staged, unstaged, deletion, untracked, and rename overlay entries', async () => {
    const repo = await createGitFixtureRepo({
      committed: [
        { path: 'keep.txt', content: 'keep' },
        { path: 'gone.txt', content: 'gone' },
        { path: 'old-name.txt', content: 'renamed-body' },
        { path: 'edit.txt', content: 'before' },
      ],
      staged: [{ path: 'staged.txt', content: 'staged' }],
      unstaged: [{ path: 'edit.txt', content: 'after' }],
      untracked: [{ path: 'new.txt', content: 'untracked' }],
      deleted: ['gone.txt'],
    });
    cleanups.push(repo.cleanup);

    // Simulate rename: remove old from index, add new
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['mv', 'old-name.txt', 'new-name.txt'], {
      cwd: repo.root,
      windowsHide: true,
    });

    const status = await gitStatusPorcelainV2(repo.root);
    const plan = computeOverlayPlan(status, {
      include_untracked: true,
      include_ignored: [],
      secret_policy: 'allow',
    });

    expect(plan.deletions).toContain('gone.txt');
    expect(plan.deletions).toContain('old-name.txt');
    expect(plan.files).toContain('staged.txt');
    expect(plan.files).toContain('edit.txt');
    expect(plan.files).toContain('new.txt');
    expect(plan.files).toContain('new-name.txt');
    expect(plan.files).not.toContain('keep.txt');
  });

  it('golden: applying overlay onto base commit reproduces dirty tree hashes', async () => {
    const repo = await createGitFixtureRepo({
      committed: [
        { path: 'a.txt', content: 'A' },
        { path: 'b.txt', content: 'B' },
        { path: 'del.txt', content: 'DEL' },
      ],
      unstaged: [{ path: 'a.txt', content: 'A-dirty' }],
      untracked: [{ path: 'u.txt', content: 'U' }],
      deleted: ['del.txt'],
    });
    cleanups.push(repo.cleanup);

    const storage = await mkdtemp(join(tmpdir(), 'rbo-overlay-cap-'));
    cleanups.push(async () => rm(storage, { recursive: true, force: true }));

    const captured = await captureGitOverlaySnapshot({
      projectRoot: repo.root,
      allowedProjectRoots: [repo.root],
      sourcePolicy: {
        include_untracked: true,
        include_ignored: [],
        secret_policy: 'allow',
      },
      contentStorageDir: storage,
      repoUrl: 'git@github.com:kuzyasun/esp32-boilerplate.git',
    });

    expect(captured.manifest.payload.mode).toBe('git_overlay');
    expect(captured.manifest.overlay.deletions).toContain('del.txt');
    expect(captured.manifest.overlay.files.map((f) => f.path).sort()).toEqual(['a.txt', 'u.txt']);

    // Materialize base: copy committed tree without dirty state via a clean checkout dir
    const baseDir = await mkdtemp(join(tmpdir(), 'rbo-overlay-base-'));
    cleanups.push(async () => rm(baseDir, { recursive: true, force: true }));
    const projectPath = join(baseDir, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'a.txt'), 'A');
    await writeFile(join(projectPath, 'b.txt'), 'B');
    await writeFile(join(projectPath, 'del.txt'), 'DEL');

    await applyGitOverlay({
      manifest: captured.manifest,
      archivePath: captured.archivePath,
      workspaceRoot: baseDir,
      projectPath,
    });

    expect(await readFile(join(projectPath, 'a.txt'), 'utf8')).toBe('A-dirty');
    expect(await readFile(join(projectPath, 'u.txt'), 'utf8')).toBe('U');
    await expect(readFile(join(projectPath, 'del.txt'))).rejects.toThrow();
    expect(await readFile(join(projectPath, 'b.txt'), 'utf8')).toBe('B');
  });

  it('captures binary and unicode overlay paths with bounded overlay bytes', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'base.txt', content: 'base' }],
      untracked: [
        { path: 'bin/data.bin', content: '\x00\x01\xffbinary' },
        { path: 'юнікод/файл.txt', content: 'привіт' },
      ],
    });
    cleanups.push(repo.cleanup);

    const storage = await mkdtemp(join(tmpdir(), 'rbo-overlay-bin-'));
    cleanups.push(async () => rm(storage, { recursive: true, force: true }));

    const captured = await captureGitOverlaySnapshot({
      projectRoot: repo.root,
      allowedProjectRoots: [repo.root],
      sourcePolicy: {
        include_untracked: true,
        include_ignored: [],
        secret_policy: 'allow',
      },
      contentStorageDir: storage,
      repoUrl: 'git@github.com:kuzyasun/esp32-boilerplate.git',
    });

    const paths = captured.manifest.overlay.files.map((f) => f.path).sort();
    expect(paths).toContain('bin/data.bin');
    expect(paths).toContain('юнікод/файл.txt');
    expect(captured.overlayBytes).toBeLessThan(64 * 1024);
  });
});
