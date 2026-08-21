import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { JobAdditionalRootSchema } from '@rbo/protocol';
import {
  RboError,
  assertRealPathContained,
  generateId,
  isSafeRelativePath,
  normalizeRepositoryUrl,
  resolveRealPath,
  sha256,
} from '@rbo/shared';
import type { z } from 'zod';
import {
  type TarEntryInput,
  type WrittenArchiveCandidateResult,
  writeZstdTarArchiveCandidate,
} from './archive.js';
import { attachContentId } from './canonical.js';
import {
  type GitSourceRequirements,
  type SubmoduleStatusEntry,
  assertLfsContentMaterialized,
  assertSubmodulesReadyForCapture,
  assertSubmodulesReadyForOverlayCapture,
  detectGitSourceRequirements,
  enumerateSubmoduleContentPaths,
  expandFullSnapshotPaths,
  gitSubmoduleStatus,
} from './git-source-policy.js';
import {
  type FileIdentity,
  type GitStatusEntry,
  type GitStatusSnapshot,
  describeRepository,
  gitFindRoot,
  gitLsFilesOthersExcludeStandard,
  gitLsFilesOthersIgnored,
  gitLsFilesStageModes,
  gitLsFilesZ,
  gitRevParseHead,
  gitStatusPorcelainV2,
  normalizeWirePath,
  resolveInside,
} from './git-status.js';
import type { FullSnapshotManifest, SnapshotFileEntry, SnapshotInstance } from './index.js';
import { FullSnapshotManifestSchema, GitOverlaySnapshotManifestSchema } from './index.js';
import type { GitOverlaySnapshotManifest } from './index.js';
import {
  type CapturedFile,
  type SourcePolicyInput,
  captureMetadataPreflightEntry,
} from './metadata-preflight.js';
import { computeOverlayPlan } from './overlay.js';
import type { SecretPolicyViolation } from './secret-policy.js';

type JobAdditionalRoot = z.infer<typeof JobAdditionalRootSchema>;
export type { CapturedFile, SourcePolicyInput } from './metadata-preflight.js';

/**
 * Controller-provided, capture-local resource limits. These are deliberately
 * not part of the snapshot manifest or wire protocol: they govern admission
 * on the Controller that is about to create temporary capture artifacts.
 */
export interface SnapshotCaptureLimits {
  maxTotalSourceBytes: number;
  maxRegularFileCount: number;
  maxSingleFileBytes: number;
  maxTemporarySnapshotBytes: number;
}

const CAPTURE_LIMIT_CONFIG_KEYS: Record<keyof SnapshotCaptureLimits, string> = {
  maxTotalSourceBytes: 'max_snapshot_source_bytes',
  maxRegularFileCount: 'max_snapshot_file_count',
  maxSingleFileBytes: 'max_snapshot_single_file_bytes',
  maxTemporarySnapshotBytes: 'max_snapshot_temporary_bytes',
};

export interface CaptureFullSnapshotInput {
  projectRoot: string;
  allowedProjectRoots: string[];
  cwd?: string;
  sourcePolicy: SourcePolicyInput;
  additionalRoots?: JobAdditionalRoot[];
  contentStorageDir: string;
  mainMount?: string;
  /** Optional controller fencing generation embedded in a private archive candidate name. */
  fencingGeneration?: number;
  /** Controller capture limits, checked from metadata before compression. */
  limits?: SnapshotCaptureLimits;
}

function releaseCapturedFileBuffers(files: CapturedFile[]): number {
  let retained = 0;
  for (const file of files) {
    if (file.content) {
      retained += file.content.length;
      file.content = undefined;
    }
    if (file.tarEntry.content) {
      file.tarEntry.content = undefined;
    }
  }
  return retained;
}

function countRetainedContentBytes(files: CapturedFile[]): number {
  let total = 0;
  for (const file of files) {
    if (file.content) {
      total += file.content.length;
    }
    if (file.tarEntry.content) {
      total += file.tarEntry.content.length;
    }
  }
  return total;
}

function assertCaptureLimit(
  limitKey: keyof SnapshotCaptureLimits,
  actual: number,
  limit: number,
  remediation: string,
): void {
  if (actual <= limit) return;
  const configKey = CAPTURE_LIMIT_CONFIG_KEYS[limitKey];
  throw new RboError(
    'validation',
    `Snapshot capture exceeds ${configKey}: actual ${actual} exceeds configured limit ${limit}. ${remediation}`,
    false,
    { limit_key: configKey, actual, limit, remediation },
  );
}

/** Check discovered file metadata before the archive writer opens any file. */
function assertSourceCaptureLimits(
  files: CapturedFile[],
  limits: SnapshotCaptureLimits | undefined,
): void {
  if (!limits) return;
  const regularFiles = files.filter(
    (file): file is CapturedFile & { entry: Extract<SnapshotFileEntry, { type: 'file' }> } =>
      file.entry.type === 'file',
  );
  assertCaptureLimit(
    'maxRegularFileCount',
    regularFiles.length,
    limits.maxRegularFileCount,
    'Reduce the capture scope or raise "max_snapshot_file_count" in controller.json.',
  );
  let totalSourceBytes = 0;
  for (const file of regularFiles) {
    assertCaptureLimit(
      'maxSingleFileBytes',
      file.entry.size,
      limits.maxSingleFileBytes,
      `Exclude or split '${file.entry.path}', or explicitly raise "max_snapshot_single_file_bytes" in controller.json.`,
    );
    totalSourceBytes += file.entry.size;
  }
  assertCaptureLimit(
    'maxTotalSourceBytes',
    totalSourceBytes,
    limits.maxTotalSourceBytes,
    'Reduce the capture scope (including additional roots) or raise "max_snapshot_source_bytes" in controller.json.',
  );
}

/**
 * Exact uncompressed ustar byte count for the pending entries. This is a
 * conservative, metadata-only admission estimate for the Controller's
 * temporary snapshot budget; it avoids starting zstd when the candidate could
 * not fit the configured working budget.
 */
function estimateTemporarySnapshotBytes(
  files: CapturedFile[],
  emptyDirectoryCount: number,
): number {
  const tarEntryBytes = files.reduce((total, file) => {
    const contentBytes = file.entry.type === 'file' ? file.entry.size : 0;
    return total + 512 + Math.ceil(contentBytes / 512) * 512;
  }, 0);
  return tarEntryBytes + emptyDirectoryCount * 512 + 1024;
}

function assertTemporarySnapshotLimit(
  files: CapturedFile[],
  emptyDirectoryCount: number,
  limits: SnapshotCaptureLimits | undefined,
): void {
  if (!limits) return;
  const estimatedBytes = estimateTemporarySnapshotBytes(files, emptyDirectoryCount);
  assertCaptureLimit(
    'maxTemporarySnapshotBytes',
    estimatedBytes,
    limits.maxTemporarySnapshotBytes,
    'Reduce the capture scope or raise "max_snapshot_temporary_bytes" after provisioning sufficient Controller disk space.',
  );
}

function assertWrittenTemporarySnapshotLimit(
  actualBytes: number,
  limits: SnapshotCaptureLimits | undefined,
): void {
  if (!limits) return;
  assertCaptureLimit(
    'maxTemporarySnapshotBytes',
    actualBytes,
    limits.maxTemporarySnapshotBytes,
    'Raise "max_snapshot_temporary_bytes" only after provisioning sufficient Controller disk space.',
  );
}

function applyArchivedFileResults(
  files: CapturedFile[],
  archive: WrittenArchiveCandidateResult,
): void {
  const byPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  for (const file of files) {
    if (file.entry.type !== 'file') continue;
    const archived = byPath.get(file.tarEntry.path);
    if (!archived) {
      throw new RboError(
        'materialization',
        `Archive did not contain captured file '${file.tarEntry.path}'`,
        false,
      );
    }
    file.entry = {
      ...file.entry,
      size: archived.size,
      sha256: archived.sha256,
    };
  }
}

function throwIfSecretViolations(violations: SecretPolicyViolation[]): void {
  if (violations.length === 0) {
    return;
  }
  const paths = [...new Set(violations.map((v) => v.path))].sort();
  throw new RboError('secret_blocked', `Secret files blocked: ${paths.join(', ')}`, false, {
    violations,
  });
}

function archiveCaptureError(error: unknown): RboError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Source file changed while archiving')) {
    return new RboError('workspace_changed', message, true, {
      reason: 'file_identity_changed',
    });
  }
  return new RboError('materialization', message, false);
}

export interface CaptureFullSnapshotResult {
  instance: SnapshotInstance;
  manifest: FullSnapshotManifest;
  archivePath: string;
  contentStorageDir: string;
  /** Secret-policy matches when mode=warn (block throws; allow is empty). */
  secretWarnings: Array<{ path: string; pattern: string }>;
  /** Agent capability hints derived during capture (§11.14–11.15). */
  gitSourceRequirements: GitSourceRequirements;
  /** Bytes still held in-process from captured file contents after archive persist (should be 0). */
  retainedContentBytes: number;
}

/** Detect paths that collide under case-insensitive comparison (pure). */
export function findCaseCollisions(paths: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.replace(/\\/g, '/').toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => {
    const unique = new Set(group);
    return unique.size > 1;
  });
}

/**
 * Detect prefix or case-fold overlaps among main_mount and additional mount paths.
 * Returns pairs of colliding mounts (pure).
 */
export function findMountPathOverlaps(mainMount: string, additionalMounts: string[]): string[][] {
  const mounts = [mainMount, ...additionalMounts].map((m) =>
    normalizeWirePath(m).replace(/\/+$/, ''),
  );
  const overlaps: string[][] = [];
  for (let i = 0; i < mounts.length; i += 1) {
    for (let j = i + 1; j < mounts.length; j += 1) {
      const a = mounts[i] as string;
      const b = mounts[j] as string;
      const aKey = a.toLowerCase();
      const bKey = b.toLowerCase();
      if (aKey === bKey || aKey.startsWith(`${bKey}/`) || bKey.startsWith(`${aKey}/`)) {
        overlaps.push([a, b]);
      }
    }
  }
  return overlaps;
}

function assertMountPathsDisjoint(mainMount: string, additionalMounts: string[]): void {
  const overlaps = findMountPathOverlaps(mainMount, additionalMounts);
  if (overlaps.length === 0) {
    return;
  }
  throw new RboError(
    'validation',
    `Snapshot mount paths overlap: ${overlaps.map((pair) => pair.join(' ↔ ')).join('; ')}`,
    false,
    { overlaps },
  );
}

interface CaptureGuardState {
  head: string;
  wirePaths: string[];
  identities: Map<string, FileIdentity>;
  additionalRoots: Array<{
    mount: string;
    paths: string[];
    identities: Map<string, FileIdentity>;
  }>;
  cleanSubmodules: SubmoduleStatusEntry[];
}

async function assertAllowedProjectRoot(
  projectRoot: string,
  allowedProjectRoots: string[],
): Promise<string> {
  const realRoot = await resolveRealPath(projectRoot);
  for (const allowed of allowedProjectRoots) {
    const realAllowed = await resolveRealPath(allowed);
    try {
      await assertRealPathContained(realAllowed, realRoot);
      return realRoot;
    } catch {
      // try next allowed root
    }
  }
  throw new RboError('materialization', `Project root is not under allowed roots: ${projectRoot}`);
}

/**
 * When `project_root` points at a subdirectory of a git repo and the caller left
 * `cwd` as the default `.`, derive the repo-relative package path (e.g. `radev`).
 *
 * Snapshot still materializes the full git tree under `main_mount`; this only
 * sets the job working directory so scripts like `pnpm install` run in the
 * package, not the monorepo root. Explicit non-default `cwd` is preserved.
 */
export async function resolveSourceCwdForCapture(
  projectRoot: string,
  cwd?: string,
): Promise<string> {
  const requested = cwd === undefined || cwd === '' ? '.' : normalizeWirePath(cwd);
  if (requested !== '.') {
    if (!isSafeRelativePath(requested, { allowDot: true })) {
      throw new RboError('validation', `cwd must be a safe relative path: ${cwd}`, false);
    }
    return requested;
  }

  const repoRoot = await gitFindRoot(projectRoot);
  const realRepo = await resolveRealPath(repoRoot);
  const realProject = await resolveRealPath(projectRoot);
  const rel = relative(realRepo, realProject).replace(/\\/g, '/');
  if (!rel || rel === '.') {
    return '.';
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new RboError(
      'validation',
      `project_root is outside its git repository: ${projectRoot}`,
      false,
    );
  }
  if (!isSafeRelativePath(rel)) {
    throw new RboError('validation', `derived cwd is unsafe: ${rel}`, false);
  }
  return rel;
}

async function statFileIdentity(repoRoot: string, wirePath: string): Promise<FileIdentity> {
  const absolute = resolveInside(repoRoot, wirePath);
  try {
    const info = await lstat(absolute);
    const fileId =
      info.ino !== undefined && info.ino !== 0
        ? `${info.dev}:${info.ino}`
        : `${info.size}:${info.mtimeMs}`;
    if (info.isSymbolicLink()) {
      return {
        path: wirePath,
        type: 'symlink',
        size: info.size,
        mtimeMs: info.mtimeMs,
        fileId,
      };
    }
    if (info.isDirectory()) {
      return {
        path: wirePath,
        type: 'directory',
        size: 0,
        mtimeMs: info.mtimeMs,
        fileId,
      };
    }
    if (info.isFile()) {
      return {
        path: wirePath,
        type: 'file',
        size: info.size,
        mtimeMs: info.mtimeMs,
        fileId,
      };
    }
    return {
      path: wirePath,
      type: 'file',
      size: info.size,
      mtimeMs: info.mtimeMs,
      fileId,
    };
  } catch {
    return { path: wirePath, type: 'missing', size: 0, mtimeMs: 0, fileId: null };
  }
}

function identitiesEqual(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.path === b.path &&
    a.type === b.type &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.fileId === b.fileId
  );
}

async function buildCaptureGuard(
  repoRoot: string,
  wirePaths: string[],
  status: GitStatusSnapshot,
  additionalRoots: JobAdditionalRoot[],
  cleanSubmodules: SubmoduleStatusEntry[],
): Promise<CaptureGuardState> {
  const identities = new Map<string, FileIdentity>();
  for (const wirePath of wirePaths) {
    identities.set(wirePath, await statFileIdentity(repoRoot, wirePath));
  }
  const additional: CaptureGuardState['additionalRoots'] = [];
  for (const root of additionalRoots) {
    const realSource = await resolveRealPath(root.source_path);
    const paths = (await enumerateAdditionalRootPaths(root)).sort();
    const rootIdentities = new Map<string, FileIdentity>();
    for (const relPath of paths) {
      rootIdentities.set(relPath, await statFileIdentity(realSource, relPath));
    }
    additional.push({
      mount: normalizeWirePath(root.mount_path),
      paths,
      identities: rootIdentities,
    });
  }
  return {
    head: status.head,
    wirePaths: [...wirePaths],
    identities,
    additionalRoots: additional,
    cleanSubmodules,
  };
}

async function validateCaptureGuard(
  repoRoot: string,
  guard: CaptureGuardState,
  sourcePolicy: SourcePolicyInput,
  additionalRoots: JobAdditionalRoot[],
): Promise<void> {
  const status = await gitStatusPorcelainV2(repoRoot);
  if (status.head !== guard.head) {
    throw new RboError('workspace_changed', 'HEAD changed during snapshot capture', true, {
      reason: 'head_changed',
    });
  }

  const currentPaths = await enumerateFullCapturePaths(
    repoRoot,
    sourcePolicy,
    guard.cleanSubmodules,
  );
  if (
    currentPaths.length !== guard.wirePaths.length ||
    currentPaths.some((path, index) => path !== guard.wirePaths[index])
  ) {
    throw new RboError(
      'workspace_changed',
      'Workspace file set changed during snapshot capture',
      true,
      {
        reason: 'path_set_changed',
      },
    );
  }

  for (const wirePath of currentPaths) {
    const before = guard.identities.get(wirePath);
    const after = await statFileIdentity(repoRoot, wirePath);
    if (!before || !identitiesEqual(before, after)) {
      throw new RboError('workspace_changed', 'Workspace changed during snapshot capture', true, {
        reason: 'file_identity_changed',
        path: wirePath,
      });
    }
  }

  for (const rootGuard of guard.additionalRoots) {
    const root = additionalRoots.find(
      (candidate) => normalizeWirePath(candidate.mount_path) === rootGuard.mount,
    );
    if (!root) {
      throw new RboError('workspace_changed', 'Additional root disappeared during capture', true, {
        reason: 'additional_root_missing',
        mount: rootGuard.mount,
      });
    }
    const currentRootPaths = (await enumerateAdditionalRootPaths(root)).sort();
    if (
      currentRootPaths.length !== rootGuard.paths.length ||
      currentRootPaths.some((path, index) => path !== rootGuard.paths[index])
    ) {
      throw new RboError(
        'workspace_changed',
        'Additional root file set changed during snapshot capture',
        true,
        { reason: 'additional_root_path_set_changed', mount: rootGuard.mount },
      );
    }
    const realSource = await resolveRealPath(root.source_path);
    for (const relPath of currentRootPaths) {
      const before = rootGuard.identities.get(relPath);
      const after = await statFileIdentity(realSource, relPath);
      if (!before || !identitiesEqual(before, after)) {
        throw new RboError(
          'workspace_changed',
          'Additional root changed during snapshot capture',
          true,
          { reason: 'additional_root_identity_changed', mount: rootGuard.mount, path: relPath },
        );
      }
    }
  }
}

async function enumerateFullSourcePaths(
  repoRoot: string,
  sourcePolicy: SourcePolicyInput,
): Promise<string[]> {
  const tracked = await gitLsFilesZ(repoRoot);
  const untracked = sourcePolicy.include_untracked
    ? await gitLsFilesOthersExcludeStandard(repoRoot)
    : [];
  const ignoredExplicit = await gitLsFilesOthersIgnored(repoRoot, sourcePolicy.include_ignored);
  const paths = new Set<string>([...tracked, ...untracked, ...ignoredExplicit]);
  return [...paths].map(normalizeWirePath).sort();
}

async function enumerateFullCapturePaths(
  repoRoot: string,
  sourcePolicy: SourcePolicyInput,
  cleanSubmodules: SubmoduleStatusEntry[],
): Promise<string[]> {
  const basePaths = await enumerateFullSourcePaths(repoRoot, sourcePolicy);
  const submoduleGitlinks = new Set(cleanSubmodules.map((entry) => entry.path));
  const submoduleContentPaths = await enumerateSubmoduleContentPaths(repoRoot, cleanSubmodules);
  return expandFullSnapshotPaths(basePaths, submoduleGitlinks, submoduleContentPaths);
}

function globMatch(pathStr: string, pattern: string): boolean {
  if (pattern === '**' || pattern === '**/*') {
    return true;
  }
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*')
      .replace(/\?/g, '[^/]')}$`,
  );
  return regex.test(pathStr);
}

async function enumerateAdditionalRootPaths(root: JobAdditionalRoot): Promise<string[]> {
  const realRoot = await resolveRealPath(root.source_path);
  const paths: string[] = [];

  async function walk(dir: string, rel = ''): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const wirePath = normalizeWirePath(entryRel);
      if (root.exclude.some((pattern) => globMatch(wirePath, pattern))) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const included = root.include.some(
          (pattern) => globMatch(wirePath, pattern) || globMatch(`${wirePath}/**`, pattern),
        );
        if (included) {
          await walk(full, entryRel);
        }
      } else if (root.include.some((pattern) => globMatch(wirePath, pattern))) {
        paths.push(wirePath);
      }
    }
  }

  await walk(realRoot);
  return paths.sort();
}

async function findEmptyUntrackedDirectories(repoRoot: string): Promise<string[]> {
  const status = await gitStatusPorcelainV2(repoRoot);
  const emptyDirs: string[] = [];
  for (const entry of status.entries) {
    if (entry.kind !== 'untracked') {
      continue;
    }
    const absolute = resolveInside(repoRoot, entry.path);
    try {
      const info = await stat(absolute);
      if (info.isDirectory()) {
        const children = await readdir(absolute);
        if (children.length === 0) {
          emptyDirs.push(normalizeWirePath(entry.path));
        }
      }
    } catch {
      // not a directory or missing
    }
  }
  return emptyDirs.sort();
}

async function cleanupContentStorage(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function archivePathForGeneration(
  contentStorageDir: string,
  basename: string,
  fencingGeneration: number | undefined,
): string {
  if (fencingGeneration === undefined) {
    return join(contentStorageDir, basename);
  }
  if (!Number.isSafeInteger(fencingGeneration) || fencingGeneration < 1) {
    throw new RboError('validation', 'fencingGeneration must be a positive safe integer', false);
  }
  return join(contentStorageDir, `${basename}.g${fencingGeneration}`);
}

export async function captureFullSnapshot(
  input: CaptureFullSnapshotInput,
): Promise<CaptureFullSnapshotResult> {
  const repoRoot = await gitFindRoot(input.projectRoot);
  await assertAllowedProjectRoot(repoRoot, input.allowedProjectRoots);

  const captureId = generateId('snp');
  const contentStorageDir = join(input.contentStorageDir, captureId);
  await mkdir(contentStorageDir, { recursive: true });

  const initialStatus = await gitStatusPorcelainV2(repoRoot);
  const repoInfo = await describeRepository(repoRoot);
  const cleanSubmodules = await assertSubmodulesReadyForCapture(repoRoot);
  const gitSourceRequirements = await detectGitSourceRequirements(repoRoot);
  const wirePaths = await enumerateFullCapturePaths(repoRoot, input.sourcePolicy, cleanSubmodules);
  await assertLfsContentMaterialized(repoRoot, wirePaths);
  const guard = await buildCaptureGuard(
    repoRoot,
    wirePaths,
    initialStatus,
    input.additionalRoots ?? [],
    cleanSubmodules,
  );
  const stageModes = await gitLsFilesStageModes(repoRoot);

  const capturedFiles: CapturedFile[] = [];
  const archivedFiles: CapturedFile[] = [];
  try {
    const caseCollisions = findCaseCollisions(wirePaths);
    if (caseCollisions.length > 0) {
      throw new RboError('materialization', 'Case-colliding paths in snapshot capture', false, {
        collisions: caseCollisions,
      });
    }

    const mainMount = input.mainMount ?? 'project';
    if (!isSafeRelativePath(mainMount)) {
      throw new RboError(
        'materialization',
        `main_mount must be a safe relative path: ${mainMount}`,
        false,
      );
    }
    assertMountPathsDisjoint(
      mainMount,
      (input.additionalRoots ?? []).map((root) => root.mount_path),
    );
    const effectiveCwd = await resolveSourceCwdForCapture(input.projectRoot, input.cwd);

    const secretWarnings: Array<{ path: string; pattern: string }> = [];
    const secretBlockedViolations: SecretPolicyViolation[] = [];
    for (const wirePath of wirePaths) {
      const absolute = resolveInside(repoRoot, wirePath);
      try {
        const info = await lstat(absolute);
        if (!info.isFile() && !info.isSymbolicLink()) {
          continue;
        }
      } catch {
        continue;
      }
      const captured = await captureMetadataPreflightEntry(
        repoRoot,
        wirePath,
        stageModes,
        input.sourcePolicy,
      );
      capturedFiles.push(captured);
      archivedFiles.push(captured);
      if (captured.secretWarnings) {
        secretWarnings.push(...captured.secretWarnings);
      }
      if (captured.secretViolations) {
        secretBlockedViolations.push(...captured.secretViolations);
      }
    }

    const emptyDirectories = await findEmptyUntrackedDirectories(repoRoot);
    const additionalRootCaptures: Array<{ root: JobAdditionalRoot; files: CapturedFile[] }> = [];
    const additionalTarEntries: TarEntryInput[] = [];

    for (const root of input.additionalRoots ?? []) {
      if (!isSafeRelativePath(root.mount_path)) {
        throw new RboError(
          'validation',
          `additional_roots.mount_path escapes snapshot storage: ${root.mount_path}`,
          false,
        );
      }
      const realSource = await resolveRealPath(root.source_path);
      let rootAllowed = false;
      for (const allowed of input.allowedProjectRoots) {
        try {
          await assertRealPathContained(await resolveRealPath(allowed), realSource);
          rootAllowed = true;
          break;
        } catch {
          // try next allowed root
        }
      }
      if (!rootAllowed) {
        throw new RboError(
          'materialization',
          `Additional root is not under allowed project roots: ${root.source_path}`,
        );
      }
      const rootPaths = await enumerateAdditionalRootPaths(root);
      const rootCaptured: CapturedFile[] = [];
      for (const relPath of rootPaths) {
        const mountPath = normalizeWirePath(join(root.mount_path, relPath));
        if (!isSafeRelativePath(mountPath)) {
          throw new RboError(
            'validation',
            `additional root archive path escapes mount: ${mountPath}`,
            false,
          );
        }
        const captured = await captureMetadataPreflightEntry(
          realSource,
          relPath,
          new Map(),
          input.sourcePolicy,
        );
        rootCaptured.push({
          ...captured,
          wirePath: mountPath,
          entry: { ...captured.entry, path: mountPath },
          tarEntry: { ...captured.tarEntry, path: mountPath },
        });
        archivedFiles.push(rootCaptured[rootCaptured.length - 1] as CapturedFile);
        if (captured.secretWarnings) {
          secretWarnings.push(
            ...captured.secretWarnings.map((warning) => ({
              ...warning,
              path: mountPath,
            })),
          );
        }
        if (captured.secretViolations) {
          secretBlockedViolations.push(
            ...captured.secretViolations.map((violation) => ({
              ...violation,
              path: mountPath,
            })),
          );
        }
      }
      additionalRootCaptures.push({ root, files: rootCaptured });
      // Additional roots go only into the archive under their mount path — not into
      // source.files (and not twice into the tar via capturedFiles).
      additionalTarEntries.push(...rootCaptured.map((f) => f.tarEntry));
    }

    assertSourceCaptureLimits(archivedFiles, input.limits);

    throwIfSecretViolations(secretBlockedViolations);

    await validateCaptureGuard(repoRoot, guard, input.sourcePolicy, input.additionalRoots ?? []);

    const tarEntries: TarEntryInput[] = [
      ...capturedFiles.map((f) => f.tarEntry),
      ...emptyDirectories.map((dir) => ({
        path: dir,
        mode: 0o755,
        type: 'directory' as const,
      })),
      ...additionalTarEntries,
    ];
    assertTemporarySnapshotLimit(archivedFiles, emptyDirectories.length, input.limits);

    const archivePath = archivePathForGeneration(
      contentStorageDir,
      'full-source.tar.zst',
      input.fencingGeneration,
    );
    let archive: WrittenArchiveCandidateResult;
    try {
      archive = await writeZstdTarArchiveCandidate(archivePath, tarEntries);
    } catch (error) {
      throw archiveCaptureError(error);
    }
    assertWrittenTemporarySnapshotLimit(archive.size, input.limits);
    await validateCaptureGuard(repoRoot, guard, input.sourcePolicy, input.additionalRoots ?? []);
    applyArchivedFileResults(archivedFiles, archive);
    const additionalRootsManifest = additionalRootCaptures.map(({ root, files }) => {
      const fileEntries = files
        .map((f) => f.entry)
        .filter((e): e is Extract<SnapshotFileEntry, { type: 'file' }> => e.type === 'file');
      return {
        id: basename(root.mount_path),
        mount: normalizeWirePath(root.mount_path),
        file_count: fileEntries.length,
        total_size: fileEntries.reduce((sum, e) => sum + e.size, 0),
        tree_sha256: sha256(
          fileEntries
            .map((e) => e.sha256)
            .sort()
            .join('\n'),
        ),
        mode: root.mode ?? 'read_only',
      };
    });
    releaseCapturedFileBuffers(capturedFiles);

    const manifestBody = {
      schema_version: 1 as const,
      repo: repoInfo.remoteUrl
        ? {
            canonical_id: normalizeRepositoryUrl(repoInfo.remoteUrl),
            url: repoInfo.remoteUrl,
            branch: repoInfo.branch,
            head_is_pushed: false,
          }
        : undefined,
      workspace: {
        main_mount: mainMount,
        cwd: effectiveCwd,
      },
      source: {
        files: capturedFiles.map((f) => f.entry).sort((a, b) => a.path.localeCompare(b.path)),
        empty_directories: emptyDirectories,
      },
      additional_roots: additionalRootsManifest,
      payload: {
        mode: 'full' as const,
        format: 'tar' as const,
        compression: 'zstd' as const,
        sha256: archive.sha256,
        size: archive.size,
      },
    };

    const manifest = attachContentId(manifestBody);
    FullSnapshotManifestSchema.parse(manifest);

    const instance: SnapshotInstance = {
      snapshot_id: captureId,
      content_id: manifest.content_id,
      captured_at: new Date().toISOString(),
    };

    return {
      instance,
      manifest,
      archivePath: archive.candidatePath,
      contentStorageDir,
      secretWarnings,
      gitSourceRequirements,
      retainedContentBytes: countRetainedContentBytes(capturedFiles),
    };
  } catch (error) {
    await cleanupContentStorage(contentStorageDir);
    throw error;
  }
}

export interface CaptureGitOverlaySnapshotInput {
  projectRoot: string;
  allowedProjectRoots: string[];
  cwd?: string;
  sourcePolicy: SourcePolicyInput;
  additionalRoots?: JobAdditionalRoot[];
  contentStorageDir: string;
  mainMount?: string;
  /** Optional controller fencing generation embedded in a private archive candidate name. */
  fencingGeneration?: number;
  /** Allowlisted remote URL for the overlay manifest (any matching remote, not only origin). */
  repoUrl?: string;
  /** Controller capture limits, checked from metadata before compression. */
  limits?: SnapshotCaptureLimits;
}

export interface CaptureGitOverlaySnapshotResult {
  instance: SnapshotInstance;
  manifest: GitOverlaySnapshotManifest;
  archivePath: string;
  contentStorageDir: string;
  secretWarnings: Array<{ path: string; pattern: string }>;
  /** Bytes transferred for the overlay archive (not the full repository). */
  overlayBytes: number;
  gitSourceRequirements: GitSourceRequirements;
  /** Bytes still held in-process from captured file contents after archive persist (should be 0). */
  retainedContentBytes: number;
}

async function collectSubmodulePinsAndOverlay(
  repoRoot: string,
  sourcePolicy: SourcePolicyInput,
  submodules: SubmoduleStatusEntry[],
  parentPath = '',
): Promise<{
  gitlinkCommits: Map<string, string>;
  submoduleHeads: Map<string, string>;
  nestedStatusEntries: GitStatusEntry[];
  nestedStageModes: Map<string, string>;
}> {
  const gitlinkCommits = new Map<string, string>();
  const submoduleHeads = new Map<string, string>();
  const nestedStatusEntries: GitStatusEntry[] = [];
  const nestedStageModes = new Map<string, string>();

  for (const sub of submodules) {
    const wirePath = parentPath ? normalizeWirePath(`${parentPath}/${sub.path}`) : sub.path;
    const subAbsRoot = resolveInside(repoRoot, wirePath);

    let headCommit: string;
    try {
      headCommit = await gitRevParseHead(subAbsRoot);
    } catch {
      headCommit = sub.commit;
    }
    gitlinkCommits.set(wirePath, headCommit);
    submoduleHeads.set(wirePath, headCommit);

    let subStatus: GitStatusSnapshot;
    try {
      subStatus = await gitStatusPorcelainV2(subAbsRoot);
    } catch {
      subStatus = { head: headCommit, branch: null, entries: [] };
    }

    let subStageModes = new Map<string, string>();
    try {
      subStageModes = await gitLsFilesStageModes(subAbsRoot);
    } catch {
      subStageModes = new Map();
    }
    for (const [p, mode] of subStageModes) {
      nestedStageModes.set(`${wirePath}/${p}`, mode);
    }

    for (const entry of subStatus.entries) {
      nestedStatusEntries.push({
        ...entry,
        path: `${wirePath}/${entry.path}`,
        origPath: entry.origPath ? `${wirePath}/${entry.origPath}` : undefined,
      });
    }

    let childSubmodules: SubmoduleStatusEntry[] = [];
    try {
      childSubmodules = await gitSubmoduleStatus(subAbsRoot);
    } catch {
      childSubmodules = [];
    }
    if (childSubmodules.length > 0) {
      const childRes = await collectSubmodulePinsAndOverlay(
        repoRoot,
        sourcePolicy,
        childSubmodules,
        wirePath,
      );
      for (const [p, c] of childRes.gitlinkCommits) {
        gitlinkCommits.set(p, c);
      }
      for (const [p, h] of childRes.submoduleHeads) {
        submoduleHeads.set(p, h);
      }
      nestedStatusEntries.push(...childRes.nestedStatusEntries);
      for (const [p, m] of childRes.nestedStageModes) {
        nestedStageModes.set(p, m);
      }
    }
  }

  return { gitlinkCommits, submoduleHeads, nestedStatusEntries, nestedStageModes };
}

/**
 * Capture an exact dirty-tree overlay against HEAD (§11 / Phase 5).
 * Archive contains only overlay files + additional roots — not the full tree.
 */
export async function captureGitOverlaySnapshot(
  input: CaptureGitOverlaySnapshotInput,
): Promise<CaptureGitOverlaySnapshotResult> {
  const repoRoot = await gitFindRoot(input.projectRoot);
  await assertAllowedProjectRoot(repoRoot, input.allowedProjectRoots);

  const captureId = generateId('snp');
  const contentStorageDir = join(input.contentStorageDir, captureId);
  await mkdir(contentStorageDir, { recursive: true });

  const initialStatus = await gitStatusPorcelainV2(repoRoot);
  const repoInfo = await describeRepository(repoRoot);
  const remoteUrl = input.repoUrl ?? repoInfo.remoteUrl;
  if (!remoteUrl) {
    throw new RboError(
      'validation',
      'git_overlay capture requires a repository remote URL (or repoUrl override)',
      false,
    );
  }
  if (!repoInfo.head) {
    throw new RboError('validation', 'git_overlay capture requires a base commit (HEAD)', false);
  }

  const submodules = await assertSubmodulesReadyForOverlayCapture(repoRoot);
  const gitSourceRequirements = await detectGitSourceRequirements(repoRoot);

  const subRes = await collectSubmodulePinsAndOverlay(repoRoot, input.sourcePolicy, submodules);
  const combinedEntries = [...initialStatus.entries, ...subRes.nestedStatusEntries];
  const combinedStatus: GitStatusSnapshot = {
    head: initialStatus.head,
    branch: initialStatus.branch,
    entries: combinedEntries,
  };
  const topStageModes = await gitLsFilesStageModes(repoRoot);
  const combinedStageModes = new Map<string, string>([
    ...topStageModes,
    ...subRes.nestedStageModes,
  ]);

  const plan = computeOverlayPlan(combinedStatus, input.sourcePolicy, {
    stageModes: combinedStageModes,
    gitlinkCommits: subRes.gitlinkCommits,
  });

  const mainMount = input.mainMount ?? 'project';
  assertMountPathsDisjoint(
    mainMount,
    (input.additionalRoots ?? []).map((r) => r.mount_path),
  );
  const effectiveCwd = await resolveSourceCwdForCapture(input.projectRoot, input.cwd);

  const guard = await buildCaptureGuard(
    repoRoot,
    plan.files,
    initialStatus,
    input.additionalRoots ?? [],
    [],
  );

  const capturedFiles: CapturedFile[] = [];
  const archivedFiles: CapturedFile[] = [];
  const secretWarnings: Array<{ path: string; pattern: string }> = [];
  const secretBlockedViolations: SecretPolicyViolation[] = [];
  try {
    const caseCollisions = findCaseCollisions([
      ...plan.files,
      ...plan.deletions,
      ...plan.gitlinks.map((g) => g.path),
    ]);
    if (caseCollisions.length > 0) {
      throw new RboError('materialization', 'Case-colliding paths in overlay capture', false, {
        collisions: caseCollisions,
      });
    }

    const gitlinkEntries: SnapshotFileEntry[] = plan.gitlinks.map((link) => ({
      path: link.path,
      type: 'gitlink' as const,
      mode: '160000' as const,
      commit: link.commit,
    }));

    for (const wirePath of plan.files) {
      if (!isSafeRelativePath(wirePath)) {
        throw new RboError('materialization', `Unsafe overlay path: ${wirePath}`);
      }
      const captured = await captureMetadataPreflightEntry(
        repoRoot,
        wirePath,
        combinedStageModes,
        input.sourcePolicy,
      );
      capturedFiles.push(captured);
      archivedFiles.push(captured);
      if (captured.secretWarnings) {
        secretWarnings.push(...captured.secretWarnings);
      }
      if (captured.secretViolations) {
        secretBlockedViolations.push(...captured.secretViolations);
      }
    }

    const emptyDirectories = (await findEmptyUntrackedDirectories(repoRoot)).filter((dir) =>
      plan.files.some((f) => f === dir || f.startsWith(`${dir}/`)),
    );

    const additionalRootCaptures: Array<{ root: JobAdditionalRoot; files: CapturedFile[] }> = [];
    const additionalTarEntries: TarEntryInput[] = [];
    for (const root of input.additionalRoots ?? []) {
      const realSource = await resolveRealPath(root.source_path);
      const rootPaths = await enumerateAdditionalRootPaths(root);
      const rootCaptured: CapturedFile[] = [];
      for (const relPath of rootPaths) {
        const captured = await captureMetadataPreflightEntry(
          realSource,
          relPath,
          new Map(),
          input.sourcePolicy,
        );
        const mount = normalizeWirePath(root.mount_path);
        const archivePath = `${mount}/${relPath}`.replace(/\\/g, '/');
        rootCaptured.push({
          ...captured,
          wirePath: archivePath,
          entry:
            captured.entry.type === 'file'
              ? { ...captured.entry, path: archivePath }
              : { ...captured.entry, path: archivePath },
          tarEntry: { ...captured.tarEntry, path: archivePath },
        });
        archivedFiles.push(rootCaptured[rootCaptured.length - 1] as CapturedFile);
        if (captured.secretWarnings) {
          secretWarnings.push(...captured.secretWarnings.map((w) => ({ ...w, path: archivePath })));
        }
        if (captured.secretViolations) {
          secretBlockedViolations.push(
            ...captured.secretViolations.map((v) => ({ ...v, path: archivePath })),
          );
        }
      }
      additionalRootCaptures.push({ root, files: rootCaptured });
      additionalTarEntries.push(...rootCaptured.map((f) => f.tarEntry));
    }

    assertSourceCaptureLimits(archivedFiles, input.limits);

    throwIfSecretViolations(secretBlockedViolations);

    // Overlay guard: only the dirty path set + submodule HEADs are tracked.
    const statusAfter = await gitStatusPorcelainV2(repoRoot);
    if (statusAfter.head !== guard.head) {
      throw new RboError('workspace_changed', 'HEAD changed during overlay capture', true, {
        reason: 'head_changed',
      });
    }
    for (const [subPath, expectedHead] of subRes.submoduleHeads) {
      let currentHead = expectedHead;
      try {
        currentHead = await gitRevParseHead(resolveInside(repoRoot, subPath));
      } catch {
        // ignore if missing
      }
      if (currentHead !== expectedHead) {
        throw new RboError(
          'workspace_changed',
          `Submodule ${subPath} HEAD changed during overlay capture`,
          true,
          { reason: 'head_changed', path: subPath },
        );
      }
    }
    for (const wirePath of guard.wirePaths) {
      const before = guard.identities.get(wirePath);
      const after = await statFileIdentity(repoRoot, wirePath);
      if (!before || !identitiesEqual(before, after)) {
        throw new RboError('workspace_changed', 'Workspace changed during overlay capture', true, {
          reason: 'file_identity_changed',
          path: wirePath,
        });
      }
    }
    for (const rootGuard of guard.additionalRoots) {
      const root = (input.additionalRoots ?? []).find(
        (candidate) => normalizeWirePath(candidate.mount_path) === rootGuard.mount,
      );
      if (!root) {
        throw new RboError(
          'workspace_changed',
          'Additional root disappeared during capture',
          true,
          {
            reason: 'additional_root_missing',
            mount: rootGuard.mount,
          },
        );
      }
      const realSource = await resolveRealPath(root.source_path);
      for (const relPath of rootGuard.paths) {
        const before = rootGuard.identities.get(relPath);
        const after = await statFileIdentity(realSource, relPath);
        if (!before || !identitiesEqual(before, after)) {
          throw new RboError(
            'workspace_changed',
            'Additional root changed during overlay capture',
            true,
            { reason: 'additional_root_identity_changed', mount: rootGuard.mount, path: relPath },
          );
        }
      }
    }

    const tarEntries: TarEntryInput[] = [
      ...capturedFiles.map((f) => f.tarEntry),
      ...emptyDirectories.map((dir) => ({
        path: dir,
        mode: 0o755,
        type: 'directory' as const,
      })),
      ...additionalTarEntries,
    ];
    assertTemporarySnapshotLimit(archivedFiles, emptyDirectories.length, input.limits);

    const archivePath = archivePathForGeneration(
      contentStorageDir,
      'overlay.tar.zst',
      input.fencingGeneration,
    );
    let archive: WrittenArchiveCandidateResult;
    try {
      archive = await writeZstdTarArchiveCandidate(archivePath, tarEntries);
    } catch (error) {
      throw archiveCaptureError(error);
    }
    assertWrittenTemporarySnapshotLimit(archive.size, input.limits);
    const postArchiveStatus = await gitStatusPorcelainV2(repoRoot);
    if (postArchiveStatus.head !== guard.head) {
      throw new RboError('workspace_changed', 'HEAD changed during overlay capture', true, {
        reason: 'head_changed',
      });
    }
    for (const [subPath, expectedHead] of subRes.submoduleHeads) {
      let currentHead = expectedHead;
      try {
        currentHead = await gitRevParseHead(resolveInside(repoRoot, subPath));
      } catch {
        // ignore if missing; the identity guard below will reject the capture
      }
      if (currentHead !== expectedHead) {
        throw new RboError(
          'workspace_changed',
          `Submodule ${subPath} HEAD changed during overlay capture`,
          true,
          { reason: 'head_changed', path: subPath },
        );
      }
    }
    for (const wirePath of guard.wirePaths) {
      const before = guard.identities.get(wirePath);
      const after = await statFileIdentity(repoRoot, wirePath);
      if (!before || !identitiesEqual(before, after)) {
        throw new RboError('workspace_changed', 'Workspace changed during overlay capture', true, {
          reason: 'file_identity_changed',
          path: wirePath,
        });
      }
    }
    for (const rootGuard of guard.additionalRoots) {
      const root = (input.additionalRoots ?? []).find(
        (candidate) => normalizeWirePath(candidate.mount_path) === rootGuard.mount,
      );
      if (!root) {
        throw new RboError(
          'workspace_changed',
          'Additional root disappeared during capture',
          true,
          {
            reason: 'additional_root_missing',
            mount: rootGuard.mount,
          },
        );
      }
      const realSource = await resolveRealPath(root.source_path);
      for (const relPath of rootGuard.paths) {
        const before = rootGuard.identities.get(relPath);
        const after = await statFileIdentity(realSource, relPath);
        if (!before || !identitiesEqual(before, after)) {
          throw new RboError(
            'workspace_changed',
            'Additional root changed during overlay capture',
            true,
            { reason: 'additional_root_identity_changed', mount: rootGuard.mount, path: relPath },
          );
        }
      }
    }
    applyArchivedFileResults(archivedFiles, archive);
    const additionalRootsManifest = additionalRootCaptures.map(({ root, files }) => {
      const fileEntries = files
        .map((f) => f.entry)
        .filter((e): e is Extract<SnapshotFileEntry, { type: 'file' }> => e.type === 'file');
      return {
        id: basename(root.mount_path),
        mount: normalizeWirePath(root.mount_path),
        file_count: fileEntries.length,
        total_size: fileEntries.reduce((sum, e) => sum + e.size, 0),
        tree_sha256: sha256(
          fileEntries
            .map((e) => e.sha256)
            .sort()
            .join('\n'),
        ),
        mode: root.mode ?? 'read_only',
      };
    });
    releaseCapturedFileBuffers(capturedFiles);

    const manifestBody = {
      schema_version: 1 as const,
      repo: {
        canonical_id: normalizeRepositoryUrl(remoteUrl),
        url: remoteUrl,
        branch: repoInfo.branch,
        base_commit: repoInfo.head,
        head_is_pushed: false,
        ...(repoInfo.branch ? { fetch_refs: [`refs/heads/${repoInfo.branch}`] } : {}),
      },
      workspace: {
        main_mount: mainMount,
        cwd: effectiveCwd,
      },
      overlay: {
        files: [...capturedFiles.map((f) => f.entry), ...gitlinkEntries].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
        deletions: plan.deletions,
        empty_directories: emptyDirectories,
      },
      additional_roots: additionalRootsManifest,
      payload: {
        mode: 'git_overlay' as const,
        format: 'tar' as const,
        compression: 'zstd' as const,
        sha256: archive.sha256,
        size: archive.size,
      },
    };

    const manifest = attachContentId(manifestBody);
    GitOverlaySnapshotManifestSchema.parse(manifest);

    const instance: SnapshotInstance = {
      snapshot_id: captureId,
      content_id: manifest.content_id,
      captured_at: new Date().toISOString(),
    };

    return {
      instance,
      manifest,
      archivePath: archive.candidatePath,
      contentStorageDir,
      secretWarnings,
      overlayBytes: archive.size,
      gitSourceRequirements,
      retainedContentBytes: countRetainedContentBytes(capturedFiles),
    };
  } catch (error) {
    await cleanupContentStorage(contentStorageDir);
    throw error;
  }
}

export async function discardCapturedContent(contentStorageDir: string): Promise<void> {
  await cleanupContentStorage(contentStorageDir);
}
