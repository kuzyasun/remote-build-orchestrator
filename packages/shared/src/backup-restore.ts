/**
 * Controller backup/restore planning and validation (Phase 8).
 * Identity material is included only via an operator-protected backup path.
 * Lives in @rbo/shared (not apps/controller) so apps/cli can validate a restore
 * before starting the Controller without a cross-app source import.
 */

import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { sha256File } from './hashing.js';
import { isSafeRelativePath } from './paths.js';

const MANIFEST_NAME = 'BACKUP_MANIFEST.json';
const BACKUP_DATABASE_FILENAME = 'controller.sqlite';
export const CONTROLLER_DATABASE_FILENAME = 'controller.db';
const DATABASE_SIDECARS = [
  `${CONTROLLER_DATABASE_FILENAME}-wal`,
  `${CONTROLLER_DATABASE_FILENAME}-shm`,
  `${CONTROLLER_DATABASE_FILENAME}-journal`,
] as const;
const RESERVED_DATABASE_PATHS = new Set([
  CONTROLLER_DATABASE_FILENAME,
  ...DATABASE_SIDECARS,
  `${BACKUP_DATABASE_FILENAME}-wal`,
  `${BACKUP_DATABASE_FILENAME}-shm`,
  `${BACKUP_DATABASE_FILENAME}-journal`,
]);
const RESTORE_STATE_DIR = '.rbo-restore-state';
const RESTORE_JOURNAL = 'journal.json';
const activeRestoreRoots = new Set<string>();
const REQUIRED_FILES = [
  BACKUP_DATABASE_FILENAME,
  'security/controller.json',
  'security/controller-cert.pem',
  'security/controller-key.pem',
  'security/signing-public.pem',
  'security/signing-private.pem',
];

const manifestSchema = z.object({
  schema_version: z.literal(1),
  created_at: z.string(),
  controller_schema_version: z.number().int().nonnegative(),
  controller_id: z.string().min(1),
  files: z.array(
    z.object({
      relative_path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size_bytes: z.number().int().nonnegative().safe(),
    }),
  ),
});

const journalSchema = z.object({
  version: z.literal(1),
  ownerPid: z.number().int().positive().max(0x7fff_ffff),
  files: z.array(z.object({ relative_path: z.string(), hadOriginal: z.boolean() })),
  sidecars: z
    .array(z.enum(DATABASE_SIDECARS))
    .refine((files) => new Set(files).size === files.length),
});
type RestoreJournal = z.infer<typeof journalSchema>;

export interface BackupPlanEntry {
  relative_path: string;
  required: boolean;
  kind: 'database' | 'attempts' | 'identity' | 'other';
}

export interface BackupManifest {
  schema_version: 1;
  created_at: string;
  controller_schema_version: number;
  controller_id: string;
  files: Array<{ relative_path: string; sha256: string; size_bytes: number }>;
}

export function planBackup(_dataDir: string): BackupPlanEntry[] {
  return [
    { relative_path: CONTROLLER_DATABASE_FILENAME, required: true, kind: 'database' },
    { relative_path: 'attempts', required: false, kind: 'attempts' },
    { relative_path: 'security', required: true, kind: 'identity' },
  ];
}

export async function createBackupManifest(
  stagingDir: string,
  controllerSchemaVersion: number,
  controllerId: string,
): Promise<BackupManifest> {
  const files: BackupManifest['files'] = [];
  async function walk(rel: string): Promise<void> {
    const abs = join(stagingDir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (childRel === MANIFEST_NAME) continue;
      assertSafeManifestPath(childRel);
      if (entry.isDirectory()) {
        await walk(childRel);
      } else {
        const absPath = join(stagingDir, childRel);
        const info = await inspectRegularPath(stagingDir, childRel);
        if (!info) throw new RestoreValidationError('missing_file', `Missing ${childRel}`);
        files.push({
          relative_path: childRel,
          sha256: await sha256File(absPath),
          size_bytes: info.size,
        });
      }
    }
  }
  await walk('');
  const manifest: BackupManifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    controller_schema_version: controllerSchemaVersion,
    controller_id: controllerId,
    files,
  };
  await writeFile(join(stagingDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function assertSafeManifestPath(path: string): void {
  const [rootPart] = path.toLowerCase().split('/');
  if (
    !isSafeRelativePath(path) ||
    path.includes('\\') ||
    path.includes(':') ||
    Array.from(path).some((character) => character < ' ') ||
    rootPart === RESTORE_STATE_DIR ||
    (rootPart !== undefined && RESERVED_DATABASE_PATHS.has(rootPart)) ||
    (rootPart === BACKUP_DATABASE_FILENAME && path !== BACKUP_DATABASE_FILENAME) ||
    path.split('/').some((part) => /[. ]$/.test(part))
  ) {
    throw new RestoreValidationError('missing_manifest', `Invalid backup path: ${path}`);
  }
}

function liveRestorePath(path: string): string {
  return path === BACKUP_DATABASE_FILENAME ? CONTROLLER_DATABASE_FILENAME : path;
}

function validateRestorePaths(files: ReadonlyArray<{ relative_path: string }>): void {
  const paths = new Set<string>();
  for (const { relative_path: path } of files) {
    assertSafeManifestPath(path);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (paths.has(key) || key.toLowerCase() === MANIFEST_NAME.toLowerCase()) {
      throw new RestoreValidationError(
        'missing_manifest',
        `Invalid duplicate backup path: ${path}`,
      );
    }
    paths.add(key);
  }
  for (const path of REQUIRED_FILES) {
    if (!files.some((file) => file.relative_path === path)) {
      throw new RestoreValidationError('missing_file', `Required backup file missing: ${path}`);
    }
  }
}

async function lstatIfPresent(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/** Reject links and nonregular files within either operator-selected directory. */
async function inspectRegularPath(root: string, relativePath: string) {
  let path = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstatIfPresent(path);
    if (!info) return null;
    const leaf = index === parts.length - 1;
    if (leaf ? !info.isFile() : !info.isDirectory()) {
      throw new RestoreValidationError('missing_file', `Unsafe backup file path: ${relativePath}`);
    }
    if (leaf) return info;
  }
  return null;
}

async function verifyBackupFile(
  root: string,
  file: BackupManifest['files'][number],
): Promise<void> {
  const info = await inspectRegularPath(root, file.relative_path);
  if (!info) throw new RestoreValidationError('missing_file', `Missing ${file.relative_path}`);
  if (
    info.size !== file.size_bytes ||
    (await sha256File(join(root, file.relative_path))) !== file.sha256
  ) {
    throw new RestoreValidationError(
      'hash_mismatch',
      `Hash or size mismatch for ${file.relative_path}`,
    );
  }
}

async function verifyBackupIdentity(root: string, manifest: BackupManifest): Promise<void> {
  try {
    const [meta, certificate, tlsKey, signingPublic, signingPrivate] = await Promise.all(
      REQUIRED_FILES.slice(1).map((path) => readFile(join(root, path), 'utf8')),
    );
    const metadata = JSON.parse(meta) as { controller_id?: string };
    const signer = createPrivateKey(signingPrivate);
    const publicSigner = createPublicKey(signingPublic);
    if (
      metadata.controller_id !== manifest.controller_id ||
      !new X509Certificate(certificate).checkPrivateKey(createPrivateKey(tlsKey)) ||
      signer.asymmetricKeyType !== 'ed25519' ||
      !createPublicKey(signer).equals(publicSigner)
    ) {
      throw new Error('Controller ID or key pair mismatch');
    }
  } catch {
    throw new RestoreValidationError('ownership_mismatch', 'Backup Controller identity is invalid');
  }
}

export class RestoreValidationError extends Error {
  readonly code:
    | 'missing_file'
    | 'hash_mismatch'
    | 'invalid_database'
    | 'unsupported_downgrade'
    | 'missing_manifest'
    | 'ownership_mismatch';

  constructor(code: RestoreValidationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Validate the manifest, staged files, and identity before preparing a restore.
 * Fails closed on missing required files, hash mismatch, ownership mismatch, or unsupported
 * schema downgrade. Pass `expectedControllerId` (the target machine's current, already-provisioned
 * Controller identity) whenever restoring onto a data dir that already has one — this rejects
 * restoring a different Controller's backup over it silently. Omit it only for a genuinely fresh
 * data dir with no prior identity, where the backup is establishing ownership for the first time.
 */
export async function validateRestore(
  stagingDir: string,
  options: {
    latestSchemaVersion: number;
    allowDowngrade?: boolean;
    expectedControllerId?: string;
  },
): Promise<BackupManifest> {
  const root = await realpath(stagingDir);
  let manifest: BackupManifest;
  try {
    if (!(await inspectRegularPath(root, MANIFEST_NAME))) throw new Error('manifest missing');
    manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, MANIFEST_NAME), 'utf8')));
  } catch {
    throw new RestoreValidationError('missing_manifest', 'BACKUP_MANIFEST.json missing or invalid');
  }

  if (
    options.expectedControllerId !== undefined &&
    manifest.controller_id !== options.expectedControllerId
  ) {
    throw new RestoreValidationError(
      'ownership_mismatch',
      `Backup belongs to controller_id '${manifest.controller_id}', not the target controller '${options.expectedControllerId}'`,
    );
  }

  if (manifest.controller_schema_version > options.latestSchemaVersion) {
    throw new RestoreValidationError(
      'unsupported_downgrade',
      `Backup schema ${manifest.controller_schema_version} is newer than supported ${options.latestSchemaVersion}`,
    );
  }
  if (
    options.allowDowngrade === false &&
    manifest.controller_schema_version < options.latestSchemaVersion
  ) {
    // Forward restore (old backup → newer code) is OK; explicit unsupported downgrade
    // of running DB is handled elsewhere. Here we only block future→past binary.
  }

  validateRestorePaths(manifest.files);
  for (const file of manifest.files) {
    await verifyBackupFile(root, file);
  }
  await verifyBackupIdentity(root, manifest);

  return manifest;
}

async function inspectDirectory(path: string): Promise<boolean> {
  const info = await lstatIfPresent(path);
  if (info && !info.isDirectory()) throw new Error(`Unsafe restore directory: ${path}`);
  return info !== null;
}

async function syncFileSystemPath(path: string, flags: 'r' | 'r+'): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Node cannot open a Windows directory for flushing. The transaction still
  // uses atomic renames and flushed file contents there.
  if (process.platform !== 'win32') await syncFileSystemPath(path, 'r');
}

async function syncDirectoryHierarchy(path: string, root: string): Promise<void> {
  // Recursive mkdir returns an extended-length path on Windows. Directory
  // flushing is unavailable there, so skip the ancestry walk entirely.
  if (process.platform === 'win32') return;
  if (!containsPath(root, path)) throw new Error(`Cannot sync restore directory outside ${root}`);
  for (let current = path; current !== root; current = dirname(current)) {
    await syncDirectory(current);
  }
  await syncDirectory(root);
}

async function renameAndSync(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  await syncDirectory(dirname(destination));
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(source));
}

function isOtherProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function retireRestore(state: string, active: string): Promise<void> {
  // The active journal must disappear atomically before cleanup can remove the
  // originals, including when an earlier rollback has restored the old state.
  const retired = join(state, `cleanup-${randomUUID()}`);
  await renameAndSync(active, retired);
  await rm(retired, { recursive: true, force: true });
}

async function rollbackRestore(
  targetRoot: string,
  active: string,
  journal: RestoreJournal,
): Promise<void> {
  for (const { relative_path: path, hadOriginal } of [...journal.files].reverse()) {
    const livePath = liveRestorePath(path);
    const originalPath = `originals/${livePath}`;
    const payloadPath = `payload/${path}`;
    const original = await inspectRegularPath(active, originalPath);
    const payload = await inspectRegularPath(active, payloadPath);
    const live = await inspectRegularPath(targetRoot, livePath);
    const destination = join(targetRoot, livePath);

    if (hadOriginal && !original && payload && live) continue;
    if (hadOriginal !== Boolean(original) || Boolean(payload) === Boolean(live)) {
      throw new Error(`Inconsistent restore journal for ${path} in ${active}`);
    }

    // Returning a published file to the payload also records rollback progress.
    // After any rename, the three file locations still describe the next step.
    if (live) await renameAndSync(destination, join(active, payloadPath));
    if (original) await renameAndSync(join(active, originalPath), destination);
  }

  for (const path of journal.sidecars) {
    const originalPath = `originals/${path}`;
    const original = await inspectRegularPath(active, originalPath);
    const live = await inspectRegularPath(targetRoot, path);
    if (Boolean(original) === Boolean(live)) {
      throw new Error(`Inconsistent restore journal for ${path} in ${active}`);
    }
    if (original) await renameAndSync(join(active, originalPath), join(targetRoot, path));
  }
}

async function recoverRestoreAtRoot(targetRoot: string): Promise<void> {
  const state = join(targetRoot, RESTORE_STATE_DIR);
  if (!(await inspectDirectory(state))) return;
  const active = join(state, 'active');
  if (await inspectDirectory(active)) {
    if (!(await inspectRegularPath(active, RESTORE_JOURNAL))) {
      throw new Error(`Restore journal is missing in ${active}`);
    }
    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(active, RESTORE_JOURNAL), 'utf8')),
    );
    validateRestorePaths(journal.files);
    if (isOtherProcessAlive(journal.ownerPid)) {
      throw new Error(`Controller restore is in progress (pid ${journal.ownerPid})`);
    }
    await rollbackRestore(targetRoot, active, journal);
    await retireRestore(state, active);
  }

  // Preparation and post-commit cleanup never own live files. Leave preparation
  // directories from other live processes alone.
  for (const entry of await readdir(state, { withFileTypes: true })) {
    const owner = /^work-([1-9]\d{0,9})-[a-zA-Z0-9]{6}$/.exec(entry.name)?.[1];
    const retired = /^cleanup-[a-f0-9-]{36}$/.test(entry.name);
    if (!entry.isDirectory() || (!retired && (!owner || isOtherProcessAlive(Number(owner))))) {
      continue;
    }
    const path = join(state, entry.name);
    if (await inspectDirectory(path)) await rm(path, { recursive: true, force: true });
  }
}

async function withRestoreAccess(targetRoot: string, action: () => Promise<void>): Promise<void> {
  const key = process.platform === 'win32' ? targetRoot.toLowerCase() : targetRoot;
  if (activeRestoreRoots.has(key)) throw new Error('Controller restore is in progress');
  activeRestoreRoots.add(key);
  try {
    await action();
  } finally {
    activeRestoreRoots.delete(key);
  }
}

/** Resolve any interrupted restore before opening the Controller database or identity. */
export async function recoverPendingControllerRestore(
  dataDir: string,
  stagingDir?: string,
): Promise<void> {
  const targetRoot = await realpath(dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!targetRoot) return;
  if (stagingDir !== undefined) {
    assertSeparateRestoreRoots(await resolveRestoreTarget(resolve(stagingDir)), targetRoot);
  }
  await withRestoreAccess(targetRoot, () => recoverRestoreAtRoot(targetRoot));
}

function containsPath(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`);
}

function assertSeparateRestoreRoots(sourceRoot: string, targetRoot: string): void {
  if (containsPath(sourceRoot, targetRoot) || containsPath(targetRoot, sourceRoot)) {
    throw new Error('Restore staging and Controller data directories must be separate');
  }
}

async function resolveRestoreTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return join(await resolveRestoreTarget(parent), basename(path));
  }
}

/** Copy and validate the private payload before publishing it into the live data dir. */
export async function applyRestoredFiles(
  stagingDir: string,
  dataDir: string,
  manifest: BackupManifest,
  validateDatabase: (path: string, schemaVersion: number) => Promise<void>,
): Promise<void> {
  validateRestorePaths(manifest.files);
  const sourceRoot = await realpath(stagingDir);
  const targetRoot = await resolveRestoreTarget(resolve(dataDir));
  assertSeparateRestoreRoots(sourceRoot, targetRoot);

  await withRestoreAccess(targetRoot, async () => {
    const created = await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    if (created) await syncDirectoryHierarchy(targetRoot, dirname(created));
    await recoverRestoreAtRoot(targetRoot);
    const state = join(targetRoot, RESTORE_STATE_DIR);
    if (!(await inspectDirectory(state))) {
      await mkdir(state, { recursive: true, mode: 0o700 });
      await syncDirectory(targetRoot);
    }
    const active = join(state, 'active');
    const candidate = await mkdtemp(join(state, `work-${process.pid}-`));
    const payloadRoot = join(candidate, 'payload');
    const originalsRoot = join(candidate, 'originals');
    const journal: RestoreJournal = { version: 1, ownerPid: process.pid, files: [], sidecars: [] };
    const stagedDirectories = new Set([candidate]);
    let activated = false;
    try {
      for (const file of manifest.files) {
        const path = file.relative_path;
        const livePath = liveRestorePath(path);
        const previous = await inspectRegularPath(targetRoot, livePath);
        journal.files.push({ relative_path: path, hadOriginal: Boolean(previous) });
        await verifyBackupFile(sourceRoot, file);
        const copy = join(payloadRoot, path);
        const directories = [dirname(copy)];
        if (previous) directories.push(dirname(join(originalsRoot, livePath)));
        for (const directory of directories) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          for (let parent = directory; parent !== candidate; parent = dirname(parent)) {
            stagedDirectories.add(parent);
          }
        }
        // Let the target filesystem reject case-folded or normalized aliases.
        await copyFile(join(sourceRoot, path), copy, fsConstants.COPYFILE_EXCL);
        await chmod(copy, 0o600);
        await verifyBackupFile(payloadRoot, file);
        await syncFileSystemPath(copy, 'r+');
      }
      await verifyBackupIdentity(payloadRoot, manifest);
      for (const file of manifest.files) {
        if (file.relative_path !== BACKUP_DATABASE_FILENAME) continue;
        const databasePath = join(payloadRoot, file.relative_path);
        await validateDatabase(databasePath, manifest.controller_schema_version);
        await verifyBackupFile(payloadRoot, file);
      }
      for (const path of DATABASE_SIDECARS) {
        if (await inspectRegularPath(targetRoot, path)) journal.sidecars.push(path);
      }
      if (journal.sidecars.length > 0) {
        await mkdir(originalsRoot, { recursive: true, mode: 0o700 });
        stagedDirectories.add(originalsRoot);
      }
      await writeFile(join(candidate, RESTORE_JOURNAL), JSON.stringify(journal), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      for (const directory of [...stagedDirectories].sort((a, b) => b.length - a.length)) {
        await syncDirectory(directory);
      }

      await rename(candidate, active);
      activated = true;
      try {
        await syncDirectory(state);
        for (const path of journal.sidecars) {
          await renameAndSync(join(targetRoot, path), join(active, 'originals', path));
        }
        for (const { relative_path: path, hadOriginal } of journal.files) {
          const livePath = liveRestorePath(path);
          const previous = await inspectRegularPath(targetRoot, livePath);
          if (Boolean(previous) !== hadOriginal)
            throw new Error(`Live restore path changed: ${path}`);
          const destination = join(targetRoot, livePath);
          const parent = dirname(destination);
          const created = await mkdir(parent, { recursive: true, mode: 0o700 });
          if (created) await syncDirectoryHierarchy(parent, dirname(created));
          if (hadOriginal) await renameAndSync(destination, join(active, 'originals', livePath));
          await renameAndSync(join(active, 'payload', path), destination);
        }
      } catch (error) {
        try {
          await rollbackRestore(targetRoot, active, journal);
          await retireRestore(state, active);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Restore rollback failed in ${state}`);
        }
        throw error;
      }
      await retireRestore(state, active);
    } finally {
      if (!activated) await rm(candidate, { recursive: true, force: true });
    }
  });
}
