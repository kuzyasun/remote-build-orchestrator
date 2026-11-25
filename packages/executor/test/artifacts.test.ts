import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@rbo/shared';
import { decompressTarZstd, parseTarArchive } from '@rbo/snapshot';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_SINGLE_ARTIFACT_BYTES, collectArtifactFiles } from '../src/artifacts.js';

const growth = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { appendFileSync } = await import('node:fs');
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (args[0] === growth.path) {
        const stream = handle.createReadStream.bind(handle);
        handle.createReadStream = (options) => {
          appendFileSync(growth.path, 'later content');
          return stream(options);
        };
      }
      return handle;
    },
  };
});

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
      expect(result.summary.rules).toEqual([
        {
          matched_count: 3,
          collected_count: 2,
          skipped_count: 1,
          skip_reasons: ['symlink artifacts are not collected'],
        },
      ]);
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
      expect(result.summary).toMatchObject({
        rules: [{ matched_count: 2, collected_count: 0 }],
        limit_exceeded: { reason: 'file_count', limit: 1, actual: 2 },
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

  it.each(['per-file', 'aggregate'])(
    'enforces the %s budget when a file grows after stat',
    async (budget) => {
      const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-growth-'));
      const tempDir = join(workspace, 'temp');
      try {
        await writeFile(join(workspace, 'a.txt'), 'aaaa');
        growth.path = join(workspace, 'b.txt');
        await writeFile(growth.path, 'bbbb');
        const result = await collectArtifactFiles({
          projectPath: workspace,
          rules: [{ glob: '*.txt' }],
          tempDir,
          maxBytes: budget === 'aggregate' ? 8 : 100,
          maxSingleFileBytes: budget === 'per-file' ? 4 : 100,
        });
        if (budget === 'aggregate') {
          expect(result.limitExceeded).toEqual({ reason: 'total_bytes', limit: 8, actual: 9 });
          expect(result.files).toEqual([]);
          expect(await readdir(tempDir)).toEqual([]);
        } else {
          expect(result.files.map((file) => file.logical_name)).toEqual(['a.txt']);
          expect(result.skipped).toEqual([
            { path: 'b.txt', reason: 'file size 5 exceeds per-file limit 4' },
          ]);
          const [artifact] = result.files;
          await writeFile(join(workspace, 'a.txt'), 'updated workspace contents');
          expect(await readFile(artifact.sourcePath, 'utf8')).toBe('aaaa');
          expect(artifact.sha256).toBe(sha256(Buffer.from('aaaa')));
          expect(await readdir(tempDir)).toHaveLength(1);
        }
      } finally {
        growth.path = '';
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

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
      expect(result.summary.rules).toEqual([
        { matched_count: 1, collected_count: 1, skipped_count: 0, skip_reasons: [] },
        { matched_count: 0, collected_count: 0, skipped_count: 0, skip_reasons: [] },
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
      const [archive] = result.files;
      if (!archive) throw new Error('expected a directory archive');
      expect(archive.logical_name).toBe('out.tar.zst');
      const data = await readFile(archive.sourcePath);
      expect(archive.size_bytes).toBe(data.length);
      expect(archive.sha256).toBe(sha256(data));
      const entries = parseTarArchive(decompressTarZstd(data));
      expect(entries).toMatchObject([
        { path: 'a.txt', type: 'file', content: Buffer.from('hello') },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('skips a directory over the raw-source budget before creating an archive', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-source-bytes-'));
    try {
      await mkdir(join(workspace, 'out'));
      const source = join(workspace, 'out', 'uncompressed.bin');
      await writeFile(source, '');
      await truncate(source, DEFAULT_MAX_SINGLE_ARTIFACT_BYTES + 1);
      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules: [{ glob: 'out', required: true }],
      });
      expect(result.files).toEqual([]);
      expect(result.skipped).toEqual([
        { path: 'out', reason: expect.stringContaining('directory source bytes exceed') },
        { path: 'out', reason: expect.stringContaining('required artifact not found') },
      ]);
      expect(result.tempPaths).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('cleans generated archives when their compressed size exceeds the total budget', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-art-compressed-budget-'));
    try {
      await mkdir(join(workspace, 'first'));
      await mkdir(join(workspace, 'second'));
      await writeFile(join(workspace, 'first', 'a.txt'), 'hello');
      await writeFile(join(workspace, 'second', 'b.txt'), 'bye');
      const rules = [{ glob: 'first' }, { glob: 'second' }];
      const baseline = await collectArtifactFiles({
        projectPath: workspace,
        rules: [rules[0]],
      });
      const maxBytes = baseline.files[0]?.size_bytes ?? 0;
      expect(maxBytes).toBeGreaterThan(0);
      const tempDir = join(workspace, 'temp');
      await mkdir(tempDir);
      await writeFile(join(tempDir, 'unrelated.txt'), 'keep');

      const result = await collectArtifactFiles({
        projectPath: workspace,
        rules,
        maxBytes,
        tempDir,
      });
      expect(result.files).toEqual([]);
      expect(result.limitExceeded).toMatchObject({ reason: 'total_bytes', limit: maxBytes });
      expect(result.limitExceeded?.actual).toBeGreaterThan(maxBytes);
      expect(await readdir(tempDir)).toEqual(['unrelated.txt']);

      const oversized = await collectArtifactFiles({
        projectPath: workspace,
        rules,
        maxBytes: 0,
        maxSingleFileBytes: 1,
        tempDir,
      });
      expect(oversized.limitExceeded).toBeUndefined();
      expect(oversized.skipped).toHaveLength(2);
      expect(oversized.skipped[0]?.reason).toContain('exceeds per-file limit');
      expect(await readdir(tempDir)).toEqual(['unrelated.txt']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
