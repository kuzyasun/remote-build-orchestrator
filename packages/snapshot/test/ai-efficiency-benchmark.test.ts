import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureFullSnapshot, captureGitOverlaySnapshot } from '../src/capture.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function repoFixture(prefix: string): Promise<{ root: string; storage: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const storage = await mkdtemp(join(tmpdir(), `${prefix}-storage-`));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'benchmark@example.test']);
  await git(root, ['config', 'user.name', 'Benchmark']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  return { root, storage };
}

function measure(
  scenario: string,
  started: number,
  before: NodeJS.MemoryUsage,
  extra: Record<string, unknown>,
) {
  const after = process.memoryUsage();
  console.log(
    JSON.stringify({
      scenario,
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
      heap_delta_bytes: after.heapUsed - before.heapUsed,
      rss_delta_bytes: after.rss - before.rss,
      ...extra,
    }),
  );
}

function estimateTarBytes(files: Array<{ type: string; size?: number }>): number {
  return (
    files.reduce(
      (sum, file) =>
        sum + 512 + (file.type === 'file' ? Math.ceil((file.size ?? 0) / 512) * 512 : 0),
      0,
    ) + 1024
  );
}

const tempBytesMethodology =
  'deterministic estimate: one 512-byte tar header per entry, 512-byte payload padding for files, plus 1024-byte tar terminator; archive writer removes this temporary tar before returning';

describe('AI efficiency snapshot benchmark harnesses (small profile)', () => {
  it('captures a full snapshot containing many small files', async () => {
    const { root, storage } = await repoFixture('rbo-ai-snapshot-small-');
    try {
      const count = 250;
      for (let i = 0; i < count; i += 1) {
        await writeFile(join(root, `file-${String(i).padStart(4, '0')}.txt`), `small-${i}\n`);
      }
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'benchmark fixture']);
      const before = process.memoryUsage();
      const started = performance.now();
      const result = await captureFullSnapshot({
        projectRoot: root,
        allowedProjectRoots: [root],
        sourcePolicy: { include_untracked: false, include_ignored: [], secret_policy: 'block' },
        contentStorageDir: storage,
      });
      const archiveBytes = (await stat(result.archivePath)).size;
      measure('full_snapshot_many_small_files', started, before, {
        file_count: result.manifest.source.files.length,
        bytes_read: result.manifest.source.files.reduce(
          (sum, file) => sum + (file.type === 'file' ? file.size : 0),
          0,
        ),
        bytes_written: archiveBytes,
        compressed_bytes: archiveBytes,
        temp_bytes: estimateTarBytes(result.manifest.source.files),
        temp_bytes_methodology: tempBytesMethodology,
        duplicate_count: 0,
        missing_count: 0,
        order_ok: result.manifest.source.files.every(
          (file, i, all) => i === 0 || file.path >= all[i - 1]?.path,
        ),
        retained_content_bytes: result.retainedContentBytes,
      });
      expect(result.manifest.source.files).toHaveLength(count);
      expect(result.retainedContentBytes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('captures a full snapshot containing one large file', async () => {
    const { root, storage } = await repoFixture('rbo-ai-snapshot-large-');
    try {
      const content = Buffer.alloc(1024 * 1024, 0x61);
      await writeFile(join(root, 'large.bin'), content);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'benchmark fixture']);
      const before = process.memoryUsage();
      const started = performance.now();
      const result = await captureFullSnapshot({
        projectRoot: root,
        allowedProjectRoots: [root],
        sourcePolicy: { include_untracked: false, include_ignored: [], secret_policy: 'block' },
        contentStorageDir: storage,
      });
      const archiveBytes = (await stat(result.archivePath)).size;
      measure('full_snapshot_one_large_file', started, before, {
        file_count: result.manifest.source.files.length,
        bytes_read: content.byteLength,
        bytes_written: archiveBytes,
        compressed_bytes: archiveBytes,
        temp_bytes: estimateTarBytes(result.manifest.source.files),
        temp_bytes_methodology: tempBytesMethodology,
        duplicate_count: 0,
        missing_count: 0,
        order_ok: true,
        retained_content_bytes: result.retainedContentBytes,
      });
      expect(result.manifest.source.files[0]?.size).toBe(content.byteLength);
      expect(result.retainedContentBytes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('captures an overlay with hundreds of dirty and untracked files', async () => {
    const { root, storage } = await repoFixture('rbo-ai-snapshot-overlay-');
    try {
      await writeFile(join(root, 'tracked.txt'), 'base\n');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'benchmark fixture']);
      await writeFile(join(root, 'tracked.txt'), 'dirty\n');
      const count = 250;
      for (let i = 0; i < count; i += 1) {
        await writeFile(
          join(root, `untracked-${String(i).padStart(4, '0')}.txt`),
          `overlay-${i}\n`,
        );
      }
      const before = process.memoryUsage();
      const started = performance.now();
      const result = await captureGitOverlaySnapshot({
        projectRoot: root,
        allowedProjectRoots: [root],
        sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'block' },
        contentStorageDir: storage,
        repoUrl: 'https://github.com/example/benchmark.git',
      });
      const archiveBytes = (await stat(result.archivePath)).size;
      const files = result.manifest.overlay.files;
      measure('git_overlay_hundreds_dirty_untracked', started, before, {
        file_count: files.length,
        bytes_read: files.reduce((sum, file) => sum + (file.type === 'file' ? file.size : 0), 0),
        bytes_written: archiveBytes,
        compressed_bytes: archiveBytes,
        temp_bytes: estimateTarBytes(files),
        temp_bytes_methodology: tempBytesMethodology,
        duplicate_count: files.length - new Set(files.map((file) => file.path)).size,
        missing_count: 0,
        order_ok: files.every((file, i, all) => i === 0 || file.path >= all[i - 1]?.path),
        retained_content_bytes: result.retainedContentBytes,
      });
      expect(files.length).toBeGreaterThanOrEqual(count + 1);
      expect(result.retainedContentBytes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);
});
