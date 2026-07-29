import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { attachContentId } from '../src/canonical.js';
import { captureFullSnapshot } from '../src/capture.js';
import { materializeFullSnapshot } from '../src/materialize.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

describe('materializeFullSnapshot (§28.2)', () => {
  it('extracts a captured full snapshot into an isolated workspace', async () => {
    const project = await mkdtemp(join(tmpdir(), 'rbo-mat-src-'));
    const storage = await mkdtemp(join(tmpdir(), 'rbo-mat-cap-'));
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-mat-ws-'));
    try {
      await runGit(project, ['init']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'Test User']);
      await writeFile(join(project, 'hello.txt'), 'hello-world');
      await runGit(project, ['add', 'hello.txt']);
      await runGit(project, ['commit', '-m', 'init']);

      const captured = await captureFullSnapshot({
        projectRoot: project,
        allowedProjectRoots: [project],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block',
        },
        contentStorageDir: storage,
      });

      const result = await materializeFullSnapshot({
        manifest: captured.manifest,
        archivePath: captured.archivePath,
        workspaceRoot: workspace,
      });

      const content = await readFile(join(result.projectPath, 'hello.txt'), 'utf8');
      expect(content).toBe('hello-world');
      expect(result.projectPath).not.toBe(project);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('materializes additional roots under their declared mount, not main_mount', async () => {
    const project = await mkdtemp(join(tmpdir(), 'rbo-mat-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'rbo-mat-extra-'));
    const storage = await mkdtemp(join(tmpdir(), 'rbo-mat-cap-'));
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-mat-ws-'));
    try {
      await runGit(project, ['init']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'Test User']);
      await writeFile(join(project, 'main.txt'), 'main');
      await runGit(project, ['add', 'main.txt']);
      await runGit(project, ['commit', '-m', 'init']);
      await writeFile(join(extra, 'dep.txt'), 'dep');

      const captured = await captureFullSnapshot({
        projectRoot: project,
        allowedProjectRoots: [project, extra],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block',
        },
        contentStorageDir: storage,
        additionalRoots: [
          {
            source_path: extra,
            mount_path: 'vendor',
            include: ['**/*'],
            exclude: [],
          },
        ],
      });

      const result = await materializeFullSnapshot({
        manifest: captured.manifest,
        archivePath: captured.archivePath,
        workspaceRoot: workspace,
      });

      expect(await readFile(join(result.projectPath, 'main.txt'), 'utf8')).toBe('main');
      expect(await readFile(join(result.workspaceRoot, 'vendor', 'dep.txt'), 'utf8')).toBe('dep');
      expect(captured.manifest.additional_roots[0]?.mode ?? 'read_only').toBe('read_only');
      await expect(
        writeFile(join(result.workspaceRoot, 'vendor', 'dep.txt'), 'mutated'),
      ).rejects.toThrow();
    } finally {
      // Restore writable so cleanup can delete on Windows.
      const { chmod } = await import('node:fs/promises');
      await chmod(join(workspace, 'vendor', 'dep.txt'), 0o666).catch(() => undefined);
      await chmod(join(workspace, 'vendor'), 0o777).catch(() => undefined);
      await rm(project, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects archive hash mismatch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-mat-ws-'));
    const archivePath = join(workspace, 'bad.tar.zst');
    try {
      await writeFile(archivePath, Buffer.from('not-a-valid-archive'));
      const manifest = attachContentId({
        schema_version: 1,
        workspace: { main_mount: 'project', cwd: 'project' },
        source: { files: [], empty_directories: [] },
        additional_roots: [],
        payload: {
          mode: 'full',
          format: 'tar',
          compression: 'zstd',
          sha256: 'a'.repeat(64),
          size: 1,
        },
      });

      await expect(
        materializeFullSnapshot({ manifest, archivePath, workspaceRoot: workspace }),
      ).rejects.toMatchObject({ category: 'snapshot_hash' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects manifests whose main_mount would escape the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-mat-escape-'));
    const archivePath = join(workspace, 'empty.tar.zst');
    try {
      await writeFile(archivePath, Buffer.from('x'));
      await expect(
        materializeFullSnapshot({
          manifest: {
            schema_version: 1,
            content_id: `sha256:${'b'.repeat(64)}`,
            workspace: { main_mount: '../../outside', cwd: 'project' },
            source: { files: [], empty_directories: [] },
            additional_roots: [],
            payload: {
              mode: 'full',
              format: 'tar',
              compression: 'zstd',
              sha256: 'a'.repeat(64),
              size: 1,
            },
          },
          archivePath,
          workspaceRoot: workspace,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects relative symlink targets that escape the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-mat-symlink-'));
    const archivePath = join(workspace, 'escape.tar.zst');
    try {
      const { createZstdTarArchive } = await import('../src/archive.js');
      const archive = createZstdTarArchive([
        {
          path: 'link',
          mode: 0o120000,
          type: 'symlink',
          target: '../../outside',
        },
      ]);
      await writeFile(archivePath, archive.data);
      const manifest = attachContentId({
        schema_version: 1,
        workspace: { main_mount: 'project', cwd: 'project' },
        source: { files: [], empty_directories: [] },
        additional_roots: [],
        payload: {
          mode: 'full',
          format: 'tar',
          compression: 'zstd',
          sha256: archive.sha256,
          size: archive.size,
        },
      });

      await expect(
        materializeFullSnapshot({ manifest, archivePath, workspaceRoot: workspace }),
      ).rejects.toMatchObject({
        category: 'materialization',
        message: expect.stringMatching(/Symlink escapes workspace/i),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
