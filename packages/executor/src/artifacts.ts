import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactRule } from '@rbo/protocol';
import { sha256 } from '@rbo/shared';
import { createZstdTarArchive } from '@rbo/snapshot';

/** Default caps for local artifact collection (configurable per call). */
export const DEFAULT_MAX_ARTIFACT_FILES = 100;
export const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_SINGLE_ARTIFACT_BYTES = DEFAULT_MAX_ARTIFACT_BYTES;

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*')
      .replace(/\?/g, '[^/]')}$`,
  );
  return regex.test(value.replace(/\\/g, '/'));
}

async function walkEntries(
  root: string,
  dir = '',
): Promise<Array<{ path: string; isDirectory: boolean }>> {
  const absolute = join(root, dir);
  const entries = await readdir(absolute, { withFileTypes: true });
  const result: Array<{ path: string; isDirectory: boolean }> = [];
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    const normalized = rel.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      result.push({ path: normalized, isDirectory: true });
      result.push(...(await walkEntries(root, rel)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      result.push({ path: normalized, isDirectory: false });
    }
  }
  return result;
}

async function archiveDirectory(sourceDir: string): Promise<Buffer> {
  const entries = await walkEntries(sourceDir);
  const tarEntries = [];
  for (const entry of entries) {
    const absolute = join(sourceDir, entry.path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory) {
      tarEntries.push({
        path: entry.path,
        mode: 0o755,
        type: 'directory' as const,
      });
      continue;
    }
    if (!info.isFile()) {
      continue;
    }
    const content = await readFile(absolute);
    tarEntries.push({
      path: entry.path,
      mode: 0o644,
      type: 'file' as const,
      content,
    });
  }
  return createZstdTarArchive(tarEntries).data;
}

export interface CollectedArtifactFile {
  logical_name: string;
  size_bytes: number;
  sha256: string;
  /** Absolute path of a temp/source file ready to rename into artifacts/. */
  sourcePath: string;
}

export interface ArtifactSkipped {
  path: string;
  reason: string;
}

export interface ArtifactLimitExceeded {
  reason: 'file_count' | 'total_bytes';
  limit: number;
  actual: number;
}

export interface ArtifactCollectionResult {
  files: CollectedArtifactFile[];
  skipped: ArtifactSkipped[];
  limitExceeded?: ArtifactLimitExceeded;
  /** Temp files created during collection (directory archives); cleaned on limit breach. */
  tempPaths: string[];
}

export async function collectArtifactFiles(input: {
  projectPath: string;
  rules: ArtifactRule[];
  maxFiles?: number;
  maxBytes?: number;
  maxSingleFileBytes?: number;
  /** Directory for temporary directory-archive blobs (defaults under project). */
  tempDir?: string;
}): Promise<ArtifactCollectionResult> {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_ARTIFACT_FILES;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxSingleFileBytes = input.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_ARTIFACT_BYTES;
  const tempDir = input.tempDir ?? join(input.projectPath, '.rbo-artifact-tmp');
  await mkdir(tempDir, { recursive: true });

  const allEntries = await walkEntries(input.projectPath);
  const matchedDirs = new Set<string>();
  const matchedFiles = new Set<string>();

  for (const rule of input.rules) {
    for (const entry of allEntries) {
      if (!globMatch(rule.glob, entry.path)) {
        continue;
      }
      if (entry.isDirectory) {
        matchedDirs.add(entry.path);
      } else {
        matchedFiles.add(entry.path);
      }
    }
  }

  // Prefer whole-directory archives; drop file matches nested under a matched dir.
  for (const file of [...matchedFiles]) {
    for (const dir of matchedDirs) {
      if (file === dir || file.startsWith(`${dir}/`)) {
        matchedFiles.delete(file);
        break;
      }
    }
  }

  const selected = [
    ...[...matchedDirs].map((path) => ({ path, isDirectory: true })),
    ...[...matchedFiles].map((path) => ({ path, isDirectory: false })),
  ].sort((a, b) => a.path.localeCompare(b.path));

  if (selected.length > maxFiles) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      files: [],
      skipped: [],
      limitExceeded: { reason: 'file_count', limit: maxFiles, actual: selected.length },
      tempPaths: [],
    };
  }

  const files: CollectedArtifactFile[] = [];
  const skipped: ArtifactSkipped[] = [];
  const tempPaths: string[] = [];
  let totalBytes = 0;

  for (const item of selected) {
    const sourcePath = join(input.projectPath, item.path);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) {
      skipped.push({ path: item.path, reason: 'symlink artifacts are not collected' });
      continue;
    }

    if (item.isDirectory) {
      const archive = await archiveDirectory(sourcePath);
      if (archive.length > maxSingleFileBytes) {
        skipped.push({
          path: item.path,
          reason: `directory archive size ${archive.length} exceeds per-file limit ${maxSingleFileBytes}`,
        });
        continue;
      }
      const projectedTotal = totalBytes + archive.length;
      if (projectedTotal > maxBytes) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        return {
          files: [],
          skipped,
          limitExceeded: { reason: 'total_bytes', limit: maxBytes, actual: projectedTotal },
          tempPaths: [],
        };
      }
      const logicalName = `${item.path}.tar.zst`;
      const tempPath = join(tempDir, `${sha256(Buffer.from(logicalName)).slice(0, 16)}.tar.zst`);
      await writeFile(tempPath, archive);
      tempPaths.push(tempPath);
      totalBytes += archive.length;
      files.push({
        logical_name: logicalName,
        size_bytes: archive.length,
        sha256: sha256(archive),
        sourcePath: tempPath,
      });
      continue;
    }

    if (!info.isFile()) {
      skipped.push({ path: item.path, reason: 'only regular files are collected' });
      continue;
    }
    if (info.size > maxSingleFileBytes) {
      skipped.push({
        path: item.path,
        reason: `file size ${info.size} exceeds per-file limit ${maxSingleFileBytes}`,
      });
      continue;
    }
    const projectedTotal = totalBytes + info.size;
    if (projectedTotal > maxBytes) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        files: [],
        skipped,
        limitExceeded: { reason: 'total_bytes', limit: maxBytes, actual: projectedTotal },
        tempPaths: [],
      };
    }
    const content = await readFile(sourcePath);
    totalBytes += content.length;
    files.push({
      logical_name: item.path,
      size_bytes: content.length,
      sha256: sha256(content),
      sourcePath,
    });
  }

  for (const rule of input.rules) {
    if (!rule.required) {
      continue;
    }
    const found = files.some((artifact) => {
      const name = artifact.logical_name.replace(/\.tar\.zst$/, '');
      return globMatch(rule.glob, artifact.logical_name) || globMatch(rule.glob, name);
    });
    if (!found) {
      // Collection problems never change outcome (§18.1) — record skip and continue.
      skipped.push({
        path: rule.glob,
        reason: `required artifact not found for glob: ${rule.glob}`,
      });
    }
  }

  return { files, skipped, tempPaths };
}

/** Move collected artifact into persistent artifacts dir (same-volume rename). */
export async function moveArtifactToStore(sourcePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  try {
    await rename(sourcePath, destPath);
  } catch {
    // Cross-device fallback (should not happen under single dataDir).
    const content = await readFile(sourcePath);
    await writeFile(destPath, content);
    await rm(sourcePath, { force: true }).catch(() => undefined);
  }
}

export { globMatch };
