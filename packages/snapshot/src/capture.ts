import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { JobAdditionalRootSchema } from '@rbo/protocol';
import {
  RboError,
  assertRealPathContained,
  generateId,
  isPathContained,
  isSafeRelativePath,
  normalizeRepositoryUrl,
  resolveRealPath,
  sha256,
} from '@rbo/shared';
import type { z } from 'zod';
import { type TarEntryInput, createZstdTarArchive } from './archive.js';
import { attachContentId } from './canonical.js';
import {
  type GitSourceRequirements,
  type SubmoduleStatusEntry,
  assertLfsContentMaterialized,
  assertSubmodulesReadyForCapture,
  detectGitSourceRequirements,
  enumerateSubmoduleContentPaths,
  expandFullSnapshotPaths,
} from './git-source-policy.js';
import {
  type FileIdentity,
  type GitStatusSnapshot,
  describeRepository,
  gitFindRoot,
  gitLsFilesOthersExcludeStandard,
  gitLsFilesOthersIgnored,
  gitLsFilesStageModes,
  gitLsFilesZ,
  gitStatusPorcelainV2,
  normalizeWirePath,
  resolveInside,
} from './git-status.js';
import type { FullSnapshotManifest, SnapshotFileEntry, SnapshotInstance } from './index.js';
import { FullSnapshotManifestSchema, GitOverlaySnapshotManifestSchema } from './index.js';
import type { GitOverlaySnapshotManifest } from './index.js';
import { computeOverlayPlan } from './overlay.js';
import { type SecretPolicyViolation, findSecretPolicyViolations } from './secret-policy.js';

type JobAdditionalRoot = z.infer<typeof JobAdditionalRootSchema>;

export interface SourcePolicyInput {
  include_untracked: boolean;
  include_ignored: string[];
  secret_policy: 'block' | 'warn' | 'allow';
}

export interface CaptureFullSnapshotInput {
  projectRoot: string;
  allowedProjectRoots: string[];
  cwd?: string;
  sourcePolicy: SourcePolicyInput;
  additionalRoots?: JobAdditionalRoot[];
  contentStorageDir: string;
  mainMount?: string;
}

export interface CapturedFile {
  wirePath: string;
  entry: SnapshotFileEntry;
  content?: Buffer;
  tarEntry: TarEntryInput;
  secretWarnings?: Array<{ path: string; pattern: string }>;
  secretViolations?: SecretPolicyViolation[];
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

export interface CaptureFullSnapshotResult {
  instance: SnapshotInstance;
  manifest: FullSnapshotManifest;
  archivePath: string;
  contentStorageDir: string;
  /** Secret-policy matches when mode=warn (block throws; allow is empty). */
  secretWarnings: Array<{ path: string; pattern: string }>;
  /** Agent capability hints derived during capture (§11.14–11.15). */
  gitSourceRequirements: GitSourceRequirements;
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

async function readSymlinkTarget(absolutePath: string): Promise<string> {
  const { readlink } = await import('node:fs/promises');
  return readlink(absolutePath);
}

function isAbsoluteSymlinkTarget(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/');
}

async function assertSymlinkAllowed(
  repoRoot: string,
  wirePath: string,
  target: string,
): Promise<void> {
  if (isAbsoluteSymlinkTarget(target)) {
    throw new RboError(
      'materialization',
      `Absolute symlink target is not allowed: ${wirePath}`,
      false,
      {
        path: wirePath,
        target,
      },
    );
  }
  const resolved = resolve(resolveInside(repoRoot, wirePath), '..', target);
  try {
    await assertRealPathContained(repoRoot, resolved);
  } catch {
    throw new RboError('materialization', `Symlink escapes workspace: ${wirePath}`, false, {
      path: wirePath,
      target,
    });
  }
}

async function captureFileEntry(
  repoRoot: string,
  wirePath: string,
  stageModes: Map<string, string>,
  sourcePolicy: SourcePolicyInput,
): Promise<CapturedFile> {
  const absolute = resolveInside(repoRoot, wirePath);
  await assertRealPathContained(repoRoot, absolute);
  const info = await lstat(absolute);

  if (info.isSymbolicLink()) {
    let target: string;
    try {
      target = await readSymlinkTarget(absolute);
    } catch {
      throw new RboError(
        'materialization',
        `Symlink unsupported on this platform: ${wirePath}`,
        false,
        {
          reason: 'symlink_unsupported',
          path: wirePath,
        },
      );
    }
    await assertSymlinkAllowed(repoRoot, wirePath, target);
    const violations = findSecretPolicyViolations(wirePath, sourcePolicy.secret_policy);
    const entry: SnapshotFileEntry = {
      path: wirePath,
      type: 'symlink',
      mode: '120000',
      target: normalizeWirePath(target),
    };
    return {
      wirePath,
      entry,
      secretWarnings:
        sourcePolicy.secret_policy === 'warn' && violations.length > 0 ? violations : undefined,
      secretViolations:
        sourcePolicy.secret_policy === 'block' && violations.length > 0 ? violations : undefined,
      tarEntry: {
        path: wirePath,
        mode: 0o120000,
        type: 'symlink',
        target: normalizeWirePath(target),
      },
    };
  }

  if (!info.isFile()) {
    throw new RboError('materialization', `Expected regular file: ${wirePath}`);
  }

  const content = await readFile(absolute);
  const hash = sha256(content);
  const violations = findSecretPolicyViolations(wirePath, sourcePolicy.secret_policy);

  const gitMode = stageModes.get(wirePath);
  const mode: '100644' | '100755' =
    gitMode === '100755' || (info.mode & 0o111) !== 0 ? '100755' : '100644';
  const entry: SnapshotFileEntry = {
    path: wirePath,
    type: 'file',
    mode,
    size: content.length,
    sha256: hash,
  };
  return {
    wirePath,
    entry,
    content,
    secretWarnings:
      sourcePolicy.secret_policy === 'warn' && violations.length > 0 ? violations : undefined,
    secretViolations:
      sourcePolicy.secret_policy === 'block' && violations.length > 0 ? violations : undefined,
    tarEntry: {
      path: wirePath,
      mode: mode === '100755' ? 0o755 : 0o644,
      type: 'file',
      content,
    },
  };
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
      const captured = await captureFileEntry(repoRoot, wirePath, stageModes, input.sourcePolicy);
      capturedFiles.push(captured);
      if (captured.secretWarnings) {
        secretWarnings.push(...captured.secretWarnings);
      }
      if (captured.secretViolations) {
        secretBlockedViolations.push(...captured.secretViolations);
      }
      if (captured.content) {
        const dest = join(contentStorageDir, wirePath);
        await mkdir(join(dest, '..'), { recursive: true });
        await writeFile(dest, captured.content);
      }
    }

    const emptyDirectories = await findEmptyUntrackedDirectories(repoRoot);
    const additionalRootsManifest = [];
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
      const additionalBase = join(contentStorageDir, 'additional');
      await mkdir(additionalBase, { recursive: true });
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
        const captured = await captureFileEntry(realSource, relPath, new Map(), input.sourcePolicy);
        rootCaptured.push({
          ...captured,
          wirePath: mountPath,
          entry: { ...captured.entry, path: mountPath },
          tarEntry: { ...captured.tarEntry, path: mountPath },
        });
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
        if (captured.content) {
          const dest = join(additionalBase, root.mount_path, relPath);
          if (!isPathContained(additionalBase, dest)) {
            throw new RboError(
              'validation',
              `additional root content path escapes snapshot storage: ${root.mount_path}`,
              false,
            );
          }
          await mkdir(join(dest, '..'), { recursive: true });
          await writeFile(dest, captured.content);
        }
      }
      const fileEntries = rootCaptured
        .map((f) => f.entry)
        .filter((e): e is Extract<SnapshotFileEntry, { type: 'file' }> => e.type === 'file');
      const totalSize = fileEntries.reduce((sum, e) => sum + e.size, 0);
      const treeHash = sha256(
        fileEntries
          .map((e) => e.sha256)
          .sort()
          .join('\n'),
      );
      additionalRootsManifest.push({
        id: basename(root.mount_path),
        mount: normalizeWirePath(root.mount_path),
        file_count: fileEntries.length,
        total_size: totalSize,
        tree_sha256: treeHash,
        mode: root.mode ?? 'read_only',
      });
      // Additional roots go only into the archive under their mount path — not into
      // source.files (and not twice into the tar via capturedFiles).
      additionalTarEntries.push(...rootCaptured.map((f) => f.tarEntry));
    }

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

    let archive: ReturnType<typeof createZstdTarArchive>;
    try {
      archive = createZstdTarArchive(tarEntries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RboError('materialization', message, false);
    }
    const archivePath = join(contentStorageDir, 'full-source.tar.zst');
    await writeFile(archivePath, archive.data);

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
      archivePath,
      contentStorageDir,
      secretWarnings,
      gitSourceRequirements,
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
  /** Optional override when origin remote is missing (tests). */
  repoUrl?: string;
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

  await assertSubmodulesReadyForCapture(repoRoot);
  const gitSourceRequirements = await detectGitSourceRequirements(repoRoot);
  const plan = computeOverlayPlan(initialStatus, input.sourcePolicy);
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
  const stageModes = await gitLsFilesStageModes(repoRoot);

  const capturedFiles: CapturedFile[] = [];
  const secretWarnings: Array<{ path: string; pattern: string }> = [];
  const secretBlockedViolations: SecretPolicyViolation[] = [];
  try {
    const caseCollisions = findCaseCollisions([...plan.files, ...plan.deletions]);
    if (caseCollisions.length > 0) {
      throw new RboError('materialization', 'Case-colliding paths in overlay capture', false, {
        collisions: caseCollisions,
      });
    }

    for (const wirePath of plan.files) {
      if (!isSafeRelativePath(wirePath)) {
        throw new RboError('materialization', `Unsafe overlay path: ${wirePath}`);
      }
      const captured = await captureFileEntry(repoRoot, wirePath, stageModes, input.sourcePolicy);
      capturedFiles.push(captured);
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

    const additionalRootsManifest: CaptureFullSnapshotResult['manifest']['additional_roots'] = [];
    const additionalTarEntries: TarEntryInput[] = [];
    for (const root of input.additionalRoots ?? []) {
      const realSource = await resolveRealPath(root.source_path);
      const rootPaths = await enumerateAdditionalRootPaths(root);
      const rootCaptured: CapturedFile[] = [];
      for (const relPath of rootPaths) {
        const captured = await captureFileEntry(realSource, relPath, new Map(), input.sourcePolicy);
        // Rewrite paths under mount for the archive
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
        if (captured.secretWarnings) {
          secretWarnings.push(...captured.secretWarnings.map((w) => ({ ...w, path: archivePath })));
        }
        if (captured.secretViolations) {
          secretBlockedViolations.push(
            ...captured.secretViolations.map((v) => ({ ...v, path: archivePath })),
          );
        }
      }
      for (const f of rootCaptured) {
        if (f.entry.type === 'file') {
          const dest = join(contentStorageDir, 'additional-staging', f.wirePath);
          await mkdir(join(dest, '..'), { recursive: true });
          if (f.content) {
            await writeFile(dest, f.content);
          }
        }
      }
      const fileEntries = rootCaptured
        .map((f) => f.entry)
        .filter((e): e is Extract<SnapshotFileEntry, { type: 'file' }> => e.type === 'file');
      const totalSize = fileEntries.reduce((sum, e) => sum + e.size, 0);
      const treeHash = sha256(
        fileEntries
          .map((e) => e.sha256)
          .sort()
          .join('\n'),
      );
      additionalRootsManifest.push({
        id: basename(root.mount_path),
        mount: normalizeWirePath(root.mount_path),
        file_count: fileEntries.length,
        total_size: totalSize,
        tree_sha256: treeHash,
        mode: root.mode ?? 'read_only',
      });
      additionalTarEntries.push(...rootCaptured.map((f) => f.tarEntry));
    }

    throwIfSecretViolations(secretBlockedViolations);

    // Overlay guard: only the dirty path set is tracked (not the full tree).
    const statusAfter = await gitStatusPorcelainV2(repoRoot);
    if (statusAfter.head !== guard.head) {
      throw new RboError('workspace_changed', 'HEAD changed during overlay capture', true, {
        reason: 'head_changed',
      });
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

    // Re-check overlay plan did not drift
    const recheck = statusAfter;
    if (recheck.head !== guard.head) {
      throw new RboError('workspace_changed', 'HEAD changed during overlay capture', true, {
        reason: 'head_changed',
      });
    }
    const replan = computeOverlayPlan(recheck, input.sourcePolicy);
    if (
      replan.files.join('\0') !== plan.files.join('\0') ||
      replan.deletions.join('\0') !== plan.deletions.join('\0')
    ) {
      throw new RboError(
        'workspace_changed',
        'Overlay path set changed during snapshot capture',
        true,
        { reason: 'overlay_path_set_changed' },
      );
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

    let archive: ReturnType<typeof createZstdTarArchive>;
    try {
      archive = createZstdTarArchive(tarEntries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RboError('materialization', message, false);
    }
    const archivePath = join(contentStorageDir, 'overlay.tar.zst');
    await writeFile(archivePath, archive.data);

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
        files: capturedFiles.map((f) => f.entry).sort((a, b) => a.path.localeCompare(b.path)),
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
      archivePath,
      contentStorageDir,
      secretWarnings,
      overlayBytes: archive.size,
      gitSourceRequirements,
    };
  } catch (error) {
    await cleanupContentStorage(contentStorageDir);
    throw error;
  }
}

export async function discardCapturedContent(contentStorageDir: string): Promise<void> {
  await cleanupContentStorage(contentStorageDir);
}
