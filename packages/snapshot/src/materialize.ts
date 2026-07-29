import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  RboError,
  isPathContained,
  isSafeRelativePath,
  resolveRealPath,
  sha256,
} from '@rbo/shared';
import { decompressTarZstd, parseTarArchive } from './archive.js';
import {
  type FullSnapshotManifest,
  FullSnapshotManifestSchema,
  type GitOverlaySnapshotManifest,
  GitOverlaySnapshotManifestSchema,
  type SnapshotFileEntry,
} from './index.js';
import type { OverlayGitlinkPin } from './overlay.js';

export interface MaterializeFullSnapshotInput {
  /** Raw or already-parsed manifest — always re-validated before use. */
  manifest: unknown;
  archivePath: string;
  workspaceRoot: string;
}

export interface MaterializedWorkspace {
  workspaceRoot: string;
  projectPath: string;
}

/**
 * Resolve a write path under workspaceRoot.
 * Lexical containment is checked BEFORE mkdir so traversal cannot create parents outside.
 */
async function safeWritePath(workspaceRoot: string, relativePath: string): Promise<string> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!isSafeRelativePath(normalized)) {
    throw new RboError('materialization', `Path escapes workspace root: ${relativePath}`);
  }
  const absolute = resolve(workspaceRoot, normalized);
  if (!isPathContained(workspaceRoot, absolute)) {
    throw new RboError('materialization', `Path escapes workspace root: ${relativePath}`);
  }
  const parent = resolve(absolute, '..');
  if (parent !== resolve(workspaceRoot) && !isPathContained(workspaceRoot, parent)) {
    throw new RboError('materialization', `Path escapes workspace root: ${relativePath}`);
  }
  await mkdir(parent, { recursive: true });
  const realWorkspace = await resolveRealPath(workspaceRoot);
  const realParent = await resolveRealPath(parent);
  const candidate = join(realParent, basename(absolute));
  if (!isPathContained(realWorkspace, candidate)) {
    throw new RboError('materialization', `Path escapes workspace root: ${relativePath}`);
  }
  return absolute;
}

function resolveArchiveEntryRelativePath(
  entryPath: string,
  manifest: FullSnapshotManifest,
): string {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!isSafeRelativePath(normalized)) {
    throw new RboError('materialization', `Archive entry path is unsafe: ${entryPath}`);
  }
  for (const root of manifest.additional_roots) {
    const mount = root.mount.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === mount || normalized.startsWith(`${mount}/`)) {
      return normalized;
    }
  }
  return `${manifest.workspace.main_mount}/${normalized}`;
}

async function applyReadOnlyTree(rootPath: string): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await applyReadOnlyTree(full);
      await chmod(full, 0o555).catch(() => undefined);
    } else {
      await chmod(full, 0o444).catch(() => undefined);
    }
  }
  await chmod(rootPath, 0o555).catch(() => undefined);
}

function isAbsoluteSymlinkTarget(target: string): boolean {
  return (
    target.startsWith('/') ||
    target.startsWith('\\\\') ||
    /^[a-zA-Z]:[\\/]/.test(target) ||
    target.includes('://')
  );
}

/**
 * Resolve a relative symlink target from its link parent and require lexical
 * (and realpath, when the target already exists) containment under workspaceRoot.
 */
async function assertSymlinkTargetContained(
  workspaceRoot: string,
  symlinkAbsolutePath: string,
  target: string,
): Promise<void> {
  if (isAbsoluteSymlinkTarget(target)) {
    throw new RboError(
      'materialization',
      `Absolute symlink not allowed: ${symlinkAbsolutePath}`,
      false,
      {
        target,
      },
    );
  }
  const parent = resolve(symlinkAbsolutePath, '..');
  const resolved = resolve(parent, target);
  if (!isPathContained(workspaceRoot, resolved)) {
    throw new RboError(
      'materialization',
      `Symlink escapes workspace: ${symlinkAbsolutePath}`,
      false,
      {
        target,
        resolved,
      },
    );
  }
  try {
    const realWorkspace = await resolveRealPath(workspaceRoot);
    const realResolved = await resolveRealPath(resolved);
    if (!isPathContained(realWorkspace, realResolved)) {
      throw new RboError(
        'materialization',
        `Symlink escapes workspace: ${symlinkAbsolutePath}`,
        false,
        { target, resolved: realResolved },
      );
    }
  } catch (error) {
    if (error instanceof RboError) {
      throw error;
    }
    // Target may not exist yet during archive extract — lexical check already passed.
  }
}

/** Extract a full-mode snapshot archive into an isolated workspace (§28.2, Appendix D). */
export async function materializeFullSnapshot(
  input: MaterializeFullSnapshotInput,
): Promise<MaterializedWorkspace> {
  const parsed = FullSnapshotManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    throw new RboError(
      'materialization',
      `Invalid full snapshot manifest: ${parsed.error.message}`,
      false,
    );
  }
  const manifest = parsed.data;

  const archiveData = await readFile(input.archivePath);
  const archiveHash = sha256(archiveData);
  if (archiveHash !== manifest.payload.sha256) {
    throw new RboError('snapshot_hash', 'Archive hash mismatch during materialization', false, {
      expected: manifest.payload.sha256,
      actual: archiveHash,
    });
  }

  const realWorkspace = await resolveRealPath(
    await mkdir(input.workspaceRoot, { recursive: true }).then(() => input.workspaceRoot),
  );
  const projectPath = await safeWritePath(realWorkspace, manifest.workspace.main_mount);
  await mkdir(projectPath, { recursive: true });

  const tar = decompressTarZstd(archiveData);
  const entries = parseTarArchive(tar);

  for (const entry of entries) {
    const relative = resolveArchiveEntryRelativePath(entry.path, manifest);
    const dest = await safeWritePath(realWorkspace, relative);

    if (entry.type === 'directory') {
      await mkdir(dest, { recursive: true });
      continue;
    }

    if (entry.type === 'symlink') {
      if (!entry.target) {
        throw new RboError('materialization', `Symlink missing target: ${entry.path}`);
      }
      await assertSymlinkTargetContained(realWorkspace, dest, entry.target);
      try {
        await symlink(entry.target, dest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (process.platform === 'win32') {
          throw new RboError('materialization', 'symlink_unsupported', false, { path: entry.path });
        }
        throw new RboError('materialization', message, false, { path: entry.path });
      }
      continue;
    }

    await writeFile(dest, entry.content);
    if (entry.mode & 0o111) {
      await chmod(dest, entry.mode);
    }
  }

  for (const emptyDir of manifest.source.empty_directories) {
    const relative = `${manifest.workspace.main_mount}/${emptyDir}`.replace(/\\/g, '/');
    await mkdir(await safeWritePath(realWorkspace, relative), { recursive: true });
  }

  for (const file of manifest.source.files) {
    if (file.type !== 'file') {
      continue;
    }
    const relative = `${manifest.workspace.main_mount}/${file.path}`.replace(/\\/g, '/');
    const dest = await safeWritePath(realWorkspace, relative);
    const content = await readFile(dest);
    const hash = sha256(content);
    if (hash !== file.sha256) {
      throw new RboError(
        'snapshot_hash',
        `File hash mismatch after materialization: ${file.path}`,
        false,
        {
          expected: file.sha256,
          actual: hash,
        },
      );
    }
  }

  for (const root of manifest.additional_roots) {
    if ((root.mode ?? 'read_only') !== 'read_only') {
      continue;
    }
    const mountPath = await safeWritePath(realWorkspace, root.mount);
    try {
      await applyReadOnlyTree(mountPath);
    } catch {
      // mount may be empty
    }
  }

  return { workspaceRoot: realWorkspace, projectPath };
}

export interface ApplyGitOverlayInput {
  manifest: unknown;
  archivePath: string;
  workspaceRoot: string;
  /** Detached worktree / project directory already checked out at base_commit. */
  projectPath: string;
}

/** Extract gitlink pins from a parsed or unparsed git_overlay manifest (ordered as in manifest). */
export function listGitlinkPins(manifest: unknown): OverlayGitlinkPin[] {
  const parsed = GitOverlaySnapshotManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.overlay.files
    .filter((f): f is Extract<SnapshotFileEntry, { type: 'gitlink' }> => f.type === 'gitlink')
    .map((f) => ({ path: f.path, commit: f.commit }));
}

/**
 * Apply a git_overlay archive onto an existing base worktree (§11 / Phase 5).
 * Order: deletions → extract overlay files/modes/symlinks → empty dirs → hash verify.
 */
export async function applyGitOverlay(input: ApplyGitOverlayInput): Promise<MaterializedWorkspace> {
  const parsed = GitOverlaySnapshotManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    throw new RboError(
      'materialization',
      `Invalid git_overlay snapshot manifest: ${parsed.error.message}`,
      false,
    );
  }
  const manifest = parsed.data;

  const archiveData = await readFile(input.archivePath);
  const archiveHash = sha256(archiveData);
  if (archiveHash !== manifest.payload.sha256) {
    throw new RboError('snapshot_hash', 'Overlay archive hash mismatch', false, {
      expected: manifest.payload.sha256,
      actual: archiveHash,
    });
  }

  const realWorkspace = await resolveRealPath(input.workspaceRoot);
  const realProject = await resolveRealPath(input.projectPath);
  if (!isPathContained(realWorkspace, realProject)) {
    throw new RboError('materialization', 'projectPath escapes workspaceRoot');
  }

  for (const deletion of manifest.overlay.deletions) {
    if (!isSafeRelativePath(deletion)) {
      throw new RboError('materialization', `Unsafe deletion path: ${deletion}`);
    }
    const dest = resolve(realProject, deletion);
    if (!isPathContained(realProject, dest)) {
      throw new RboError('materialization', `Deletion escapes project: ${deletion}`);
    }
    await rm(dest, { recursive: true, force: true });
  }

  const tar = decompressTarZstd(archiveData);
  const entries = parseTarArchive(tar);

  const gitlinkPaths = new Set(
    manifest.overlay.files.filter((f) => f.type === 'gitlink').map((f) => f.path),
  );

  for (const entry of entries) {
    const normalized = entry.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!isSafeRelativePath(normalized)) {
      throw new RboError('materialization', `Overlay entry path is unsafe: ${entry.path}`);
    }
    if (gitlinkPaths.has(normalized)) {
      throw new RboError(
        'materialization',
        `Archive contains member at gitlink path: ${entry.path}`,
      );
    }

    // Additional-root mounts are workspace-relative; overlay files are project-relative.
    const isAdditional = manifest.additional_roots.some((root) => {
      const mount = root.mount.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalized === mount || normalized.startsWith(`${mount}/`);
    });
    const dest = isAdditional
      ? await safeWritePath(realWorkspace, normalized)
      : await safeWritePath(realProject, normalized);

    if (entry.type === 'directory') {
      await mkdir(dest, { recursive: true });
      continue;
    }

    if (entry.type === 'symlink') {
      if (!entry.target) {
        throw new RboError('materialization', `Symlink missing target: ${entry.path}`);
      }
      const containRoot = isAdditional ? realWorkspace : realProject;
      await assertSymlinkTargetContained(containRoot, dest, entry.target);
      try {
        await symlink(entry.target, dest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (process.platform === 'win32') {
          throw new RboError('materialization', 'symlink_unsupported', false, { path: entry.path });
        }
        throw new RboError('materialization', message, false, { path: entry.path });
      }
      continue;
    }

    await writeFile(dest, entry.content);
    if (entry.mode & 0o111) {
      await chmod(dest, entry.mode);
    }
  }

  for (const emptyDir of manifest.overlay.empty_directories) {
    if (!isSafeRelativePath(emptyDir)) {
      throw new RboError('materialization', `Unsafe empty directory: ${emptyDir}`);
    }
    await mkdir(await safeWritePath(realProject, emptyDir), { recursive: true });
  }

  for (const file of manifest.overlay.files) {
    if (file.type !== 'file') {
      continue;
    }
    const dest = await safeWritePath(realProject, file.path);
    const content = await readFile(dest);
    const hash = sha256(content);
    if (hash !== file.sha256) {
      throw new RboError(
        'snapshot_hash',
        `Overlay file hash mismatch after apply: ${file.path}`,
        false,
        { expected: file.sha256, actual: hash },
      );
    }
  }

  for (const root of manifest.additional_roots) {
    if ((root.mode ?? 'read_only') !== 'read_only') {
      continue;
    }
    const mountPath = await safeWritePath(realWorkspace, root.mount);
    try {
      await applyReadOnlyTree(mountPath);
    } catch {
      // mount may be empty
    }
  }

  return { workspaceRoot: realWorkspace, projectPath: realProject };
}
