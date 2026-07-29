import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectArtifactFiles } from '../src/artifacts.js';

describe('collectArtifactFiles (§22.1)', () => {
  it('skips symlink artifacts and continues collecting regular files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-skip-'));
    try {
      await writeFile(join(workspace, 'good.txt'), 'ok');
      await writeFile(join(workspace, 'target.txt'), 'target');
      await symlink('target.txt', join(workspace, 'link.txt'));
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: '*.txt' }],
      });
      expect(result.files.map((f) => f.logical_name).sort()).toEqual(['good.txt', 'target.txt']);
      expect(result.skipped).toEqual([
        expect.objectContaining({ path: 'link.txt', reason: expect.stringContaining('symlink') }),
      ]);
      expect(result.limitExceeded).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('skips oversized single files and continues collecting others', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-size-'));
    try {
      await writeFile(join(workspace, 'small.txt'), 'x');
      await writeFile(join(workspace, 'big.txt'), 'y'.repeat(200));
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: '*.txt' }],
        maxSingleFileBytes: 50,
      });
      expect(result.files.map((f) => f.logical_name)).toEqual(['small.txt']);
      expect(result.skipped).toEqual([
        expect.objectContaining({ path: 'big.txt', reason: expect.stringContaining('size') }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns limitExceeded without files when aggregate file count is breached', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-count-'));
    try {
      await writeFile(join(workspace, 'a.txt'), 'a');
      await writeFile(join(workspace, 'b.txt'), 'b');
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: '*.txt' }],
        maxFiles: 1,
      });
      expect(result.files).toEqual([]);
      expect(result.limitExceeded).toMatchObject({
        reason: 'file_count',
        limit: 1,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns limitExceeded without files when aggregate byte total is breached', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-bytes-'));
    try {
      await writeFile(join(workspace, 'a.txt'), 'aaaa');
      await writeFile(join(workspace, 'b.txt'), 'bbbb');
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: '*.txt' }],
        maxBytes: 6,
      });
      expect(result.files).toEqual([]);
      expect(result.limitExceeded).toMatchObject({
        reason: 'total_bytes',
        limit: 6,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('skips missing required artifacts without throwing (outcome unchanged)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-req-'));
    try {
      await writeFile(join(workspace, 'a.txt'), 'a');
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: '*.txt' }, { glob: 'missing.bin', required: true }],
      });
      expect(result.files.map((f) => f.logical_name)).toEqual(['a.txt']);
      expect(result.skipped).toEqual([
        expect.objectContaining({
          path: 'missing.bin',
          reason: expect.stringContaining('required artifact'),
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('archives matched directories as tar.zst', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-dir-'));
    try {
      await mkdir(join(workspace, 'out'), { recursive: true });
      await writeFile(join(workspace, 'out', 'a.txt'), 'hello');
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: 'out' }],
      });
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.logical_name).toBe('out.tar.zst');
      expect(result.files[0]?.size_bytes).toBeGreaterThan(0);
      expect(result.files[0]?.sourcePath).toBeTruthy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
