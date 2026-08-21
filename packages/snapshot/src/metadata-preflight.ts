import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RboError, assertRealPathContained } from '@rbo/shared';
import type { TarEntryInput } from './archive.js';
import { normalizeWirePath, resolveInside } from './git-status.js';
import type { SnapshotFileEntry } from './index.js';
import { type SecretPolicyViolation, findSecretPolicyViolations } from './secret-policy.js';

/**
 * Bounded worker-pool used only by the S-05 metadata-concurrency experiment.
 *
 * Capture continues to use the sequential path until real Windows NTFS and Linux
 * benchmark evidence meets the adoption thresholds in §4.4 / S-05.
 */
export const metadataPreflightExperimentWorkerCounts = [1, 4, 8] as const;
export type MetadataPreflightExperimentWorkerCount =
  (typeof metadataPreflightExperimentWorkerCounts)[number];

export interface MetadataPreflightExperimentOptions<Item, Result> {
  /** Input order is preserved in the returned metadata, regardless of completion order. */
  items: readonly Item[];
  /** The experiment profile to run. This is deliberately required: no production default exists. */
  workerCount: number;
  inspect: (item: Item, index: number) => Promise<Result>;
}

/**
 * Run metadata-only inspection with a bounded amount of in-flight work.
 *
 * Results retain input order so the archive writer can retain its deterministic,
 * sorted output while payload reading remains a later sequential operation.
 */
export async function runMetadataPreflightExperiment<Item, Result>(
  options: MetadataPreflightExperimentOptions<Item, Result>,
): Promise<Result[]> {
  if (!metadataPreflightExperimentWorkerCounts.some((count) => count === options.workerCount)) {
    throw new RangeError('workerCount must be one of the S-05 profiles: 1, 4, or 8');
  }

  const results = new Array<Result>(options.items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workerCount = Math.min(options.workerCount, options.items.length);

  async function worker(): Promise<void> {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.items.length) {
        return;
      }
      try {
        results[index] = await options.inspect(options.items[index] as Item, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed) {
    throw failure;
  }
  return results;
}

export interface SourcePolicyInput {
  include_untracked: boolean;
  include_ignored: string[];
  secret_policy: 'block' | 'warn' | 'allow';
}

export interface CapturedFile {
  wirePath: string;
  entry: SnapshotFileEntry;
  content?: Buffer;
  tarEntry: TarEntryInput;
  secretWarnings?: Array<{ path: string; pattern: string }>;
  secretViolations?: SecretPolicyViolation[];
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

/**
 * Production metadata preflight for one capture path. The S-05 benchmark uses
 * this exact operation while production capture calls it sequentially.
 */
export async function captureMetadataPreflightEntry(
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

  const violations = findSecretPolicyViolations(wirePath, sourcePolicy.secret_policy);
  const gitMode = stageModes.get(wirePath);
  const mode: '100644' | '100755' =
    gitMode === '100755' || (info.mode & 0o111) !== 0 ? '100755' : '100644';
  const entry: SnapshotFileEntry = {
    path: wirePath,
    type: 'file',
    mode,
    size: info.size,
    sha256: '',
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
      mode: mode === '100755' ? 0o755 : 0o644,
      type: 'file',
      contentPath: absolute,
    },
  };
}
