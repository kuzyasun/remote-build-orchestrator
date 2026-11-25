import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactCollectionSummary, ArtifactRule } from '@rbo/protocol';
import { sha256 } from '@rbo/shared';
import {
  ArchiveBudgetExceeded,
  type TarEntryInput,
  writeZstdTarArchiveCandidate,
} from '@rbo/snapshot';

/** Default caps for local artifact collection (configurable per call). */
export const DEFAULT_MAX_ARTIFACT_FILES = 100;
export const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_SINGLE_ARTIFACT_BYTES = DEFAULT_MAX_ARTIFACT_BYTES;
const MAX_DIRECTORY_ARTIFACT_ENTRIES = 100_000;

function compileGlob(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*')
      .replace(/\?/g, '[^/]')}$`,
  );
}

function globMatch(pattern: string, value: string): boolean {
  return compileGlob(pattern).test(value.replace(/\\/g, '/'));
}

interface WorkspaceEntry {
  path: string;
  sourcePath: string;
  isDirectory: boolean;
}

async function* walkEntries(
  root: string,
  excludedDir: string,
  dir = '',
): AsyncGenerator<WorkspaceEntry> {
  for await (const entry of await opendir(join(root, dir))) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    const sourcePath = join(root, rel);
    // A literal backslash in a POSIX filename cannot round-trip through the
    // slash-delimited artifact and tar paths.
    if (sourcePath === excludedDir || entry.name.includes('\\')) {
      continue;
    }
    const isDirectory = entry.isDirectory();
    if (isDirectory || entry.isFile() || entry.isSymbolicLink()) {
      yield { path: rel, sourcePath, isDirectory };
    }
    if (isDirectory) {
      yield* walkEntries(root, excludedDir, rel);
    }
  }
}

async function directoryArchiveEntries(
  sourceDir: string,
  excludedDir: string,
  maxSourceBytes: number,
): Promise<TarEntryInput[]> {
  const tarEntries: TarEntryInput[] = [];
  let bytes = 0;
  let entryCount = 0;
  for await (const entry of walkEntries(sourceDir, excludedDir)) {
    entryCount += 1;
    if (entryCount > MAX_DIRECTORY_ARTIFACT_ENTRIES) {
      throw new ArchiveBudgetExceeded('entry_count', MAX_DIRECTORY_ARTIFACT_ENTRIES, entryCount);
    }
    const info = await lstat(entry.sourcePath);
    if (!info.isDirectory() && !info.isFile()) {
      continue;
    }
    if (Buffer.byteLength(entry.path) > 255) {
      throw new Error(`Artifact path exceeds the tar path limit: ${entry.path}`);
    }
    if (info.isDirectory()) {
      tarEntries.push({ path: entry.path, mode: 0o755, type: 'directory' });
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > maxSourceBytes) {
        throw new ArchiveBudgetExceeded('source_bytes', maxSourceBytes, bytes);
      }
      tarEntries.push({
        path: entry.path,
        mode: 0o644,
        type: 'file',
        contentPath: entry.sourcePath,
      });
    }
  }
  return tarEntries;
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
  summary: ArtifactCollectionSummary;
  /** Staged candidates created during collection, cleaned on limit breach. */
  tempPaths: string[];
}

async function stageRegularArtifact(
  sourcePath: string,
  listed: Stats,
  tempDir: string,
  maxFileBytes: number,
  remainingBytes: number,
): Promise<Omit<CollectedArtifactFile, 'logical_name'> | null> {
  const checkSize = (size: number) => {
    if (size > maxFileBytes) {
      throw new ArchiveBudgetExceeded('output_bytes', maxFileBytes, size);
    }
    if (size > remainingBytes) {
      throw new ArchiveBudgetExceeded('stored_bytes', remainingBytes, size);
    }
  };
  const source = await open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await source.stat();
    if (!before.isFile() || before.dev !== listed.dev || before.ino !== listed.ino) {
      return null;
    }
    checkSize(before.size);
    await mkdir(tempDir, { recursive: true });
    const candidatePath = join(tempDir, `artifact-${randomUUID()}.candidate`);
    const candidate = await open(candidatePath, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      try {
        await pipeline(
          source.createReadStream({
            autoClose: false,
            start: 0,
            // The inclusive end gives us one extra byte to detect growth past the budget.
            end: Math.floor(Math.min(maxFileBytes, remainingBytes)),
          }),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              try {
                size += chunk.length;
                checkSize(size);
                hash.update(chunk);
                done(null, chunk);
              } catch (error) {
                done(error as Error);
              }
            },
          }),
          candidate.createWriteStream(),
        );
      } finally {
        await candidate.close();
      }
      return { sourcePath: candidatePath, size_bytes: size, sha256: hash.digest('hex') };
    } catch (error) {
      await rm(candidatePath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await source.close();
  }
}

function summarizeCollection(
  rules: ArtifactRule[],
  matchedCounts: number[],
  files: CollectedArtifactFile[],
  skipped: ArtifactSkipped[],
  limitExceeded?: ArtifactLimitExceeded,
): ArtifactCollectionSummary {
  return {
    rules: rules.map((rule, index) => {
      const matchingSkipped = skipped.filter(
        (item) =>
          !item.reason.startsWith('required artifact not found for glob:') &&
          globMatch(rule.glob, item.path),
      );
      return {
        matched_count: matchedCounts[index] ?? 0,
        collected_count: files.filter((file) => {
          const name = file.logical_name.replace(/\.tar\.zst$/, '');
          return globMatch(rule.glob, file.logical_name) || globMatch(rule.glob, name);
        }).length,
        skipped_count: matchingSkipped.length,
        skip_reasons: [...new Set(matchingSkipped.map((item) => item.reason.slice(0, 160)))].slice(
          0,
          3,
        ),
      };
    }),
    ...(limitExceeded ? { limit_exceeded: limitExceeded } : {}),
  };
}

export async function collectArtifactFiles(input: {
  projectPath: string;
  rules: ArtifactRule[];
  maxFiles?: number;
  maxBytes?: number;
  maxSingleFileBytes?: number;
  /** Directory for staged artifact candidates (defaults under project). */
  tempDir?: string;
}): Promise<ArtifactCollectionResult> {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_ARTIFACT_FILES;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxSingleFileBytes = input.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_ARTIFACT_BYTES;
  const projectPath = resolve(input.projectPath);
  const tempDir = resolve(input.tempDir ?? join(projectPath, '.rbo-artifact-tmp'));
  // Use a raw-source budget independently of compression so small custom
  // output caps still allow directory artifacts containing compressible files.
  const maxSourceBytes = Math.max(DEFAULT_MAX_SINGLE_ARTIFACT_BYTES, maxSingleFileBytes);
  const matchedCounts = input.rules.map(() => 0);
  if (input.rules.length === 0) {
    return { files: [], skipped: [], tempPaths: [], summary: { rules: [] } };
  }
  const patterns = input.rules.map(({ glob }) => compileGlob(glob));
  const selected: WorkspaceEntry[] = [];
  let selectedCount = 0;
  let matchedAncestor: string | undefined;
  for await (const entry of walkEntries(projectPath, tempDir)) {
    if (matchedAncestor && !entry.path.startsWith(matchedAncestor)) {
      matchedAncestor = undefined;
    }
    let matched = false;
    for (const [index, pattern] of patterns.entries()) {
      if (pattern.test(entry.path)) {
        matchedCounts[index] = (matchedCounts[index] ?? 0) + 1;
        matched = true;
      }
    }
    // The depth-first walk sees a matching directory before any of its files.
    if (matched && (entry.isDirectory || !matchedAncestor)) {
      if (entry.isDirectory) {
        matchedAncestor ??= `${entry.path}/`;
      }
      selectedCount += 1;
      if (selectedCount <= maxFiles) {
        selected.push(entry);
      }
    }
  }

  const files: CollectedArtifactFile[] = [];
  const skipped: ArtifactSkipped[] = [];
  const tempPaths: string[] = [];
  const discardTempFiles = () =>
    Promise.all(tempPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
  const failure = async (
    limitExceeded: ArtifactLimitExceeded,
  ): Promise<ArtifactCollectionResult> => {
    await discardTempFiles();
    return {
      files: [],
      skipped,
      limitExceeded,
      summary: summarizeCollection(input.rules, matchedCounts, [], skipped, limitExceeded),
      tempPaths: [],
    };
  };
  if (selectedCount > maxFiles) {
    return failure({ reason: 'file_count', limit: maxFiles, actual: selectedCount });
  }

  selected.sort((a, b) => a.path.localeCompare(b.path));
  let totalBytes = 0;

  for (const { path, sourcePath, isDirectory } of selected) {
    const info = await lstat(sourcePath).catch(async (error) => {
      await discardTempFiles();
      throw error;
    });
    if (info.isSymbolicLink()) {
      skipped.push({ path, reason: 'symlink artifacts are not collected' });
      continue;
    }

    if (isDirectory && info.isDirectory()) {
      const logicalName = `${path}.tar.zst`;
      const tempPath = join(tempDir, `${sha256(Buffer.from(logicalName)).slice(0, 16)}.tar.zst`);
      try {
        const entries = await directoryArchiveEntries(sourcePath, tempDir, maxSourceBytes);
        await mkdir(tempDir, { recursive: true });
        const archive = await writeZstdTarArchiveCandidate(tempPath, entries, {
          maxSourceBytes,
          maxOutputBytes: maxSingleFileBytes,
          maxStoredBytes: maxBytes - totalBytes,
        });
        tempPaths.push(archive.candidatePath);
        totalBytes += archive.size;
        files.push({
          logical_name: logicalName,
          size_bytes: archive.size,
          sha256: archive.sha256,
          sourcePath: archive.candidatePath,
        });
      } catch (error) {
        if (!(error instanceof ArchiveBudgetExceeded)) {
          await discardTempFiles();
          throw error;
        }
        if (error.budget === 'stored_bytes') {
          return failure({
            reason: 'total_bytes',
            limit: maxBytes,
            actual: totalBytes + error.actual,
          });
        }
        const reason =
          error.budget === 'output_bytes'
            ? `directory archive size exceeds per-file limit ${maxSingleFileBytes}`
            : error.budget === 'source_bytes'
              ? `directory source bytes exceed limit ${maxSourceBytes}`
              : `directory entry count exceeds limit ${MAX_DIRECTORY_ARTIFACT_ENTRIES}`;
        skipped.push({ path, reason });
      }
      continue;
    }

    if (!info.isFile()) {
      skipped.push({ path, reason: 'only regular files are collected' });
      continue;
    }
    try {
      const candidate = await stageRegularArtifact(
        sourcePath,
        info,
        tempDir,
        maxSingleFileBytes,
        maxBytes - totalBytes,
      );
      if (!candidate) {
        skipped.push({ path, reason: 'regular file changed before collection' });
        continue;
      }
      tempPaths.push(candidate.sourcePath);
      totalBytes += candidate.size_bytes;
      files.push({ logical_name: path, ...candidate });
    } catch (error) {
      if (!(error instanceof ArchiveBudgetExceeded)) {
        await discardTempFiles();
        throw error;
      }
      if (error.budget === 'stored_bytes') {
        return failure({
          reason: 'total_bytes',
          limit: maxBytes,
          actual: totalBytes + error.actual,
        });
      }
      skipped.push({
        path,
        reason: `file size ${error.actual} exceeds per-file limit ${maxSingleFileBytes}`,
      });
    }
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

  return {
    files,
    skipped,
    tempPaths,
    summary: summarizeCollection(input.rules, matchedCounts, files, skipped),
  };
}

/** Move collected artifact into persistent artifacts dir (same-volume rename). */
export async function moveArtifactToStore(sourcePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  try {
    await rename(sourcePath, destPath);
  } catch {
    // Cross-device fallback (should not happen under single dataDir).
    await copyFile(sourcePath, destPath);
    await rm(sourcePath, { force: true }).catch(() => undefined);
  }
}

export { globMatch };
