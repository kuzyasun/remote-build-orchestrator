/**
 * Resolve path to `rbo-windows-executor.exe` (Windows Job Object helper).
 *
 * Order:
 * 1. `RBO_WINDOWS_EXECUTOR` env override
 * 2. Optional npm package `@gemslibe/rbo-windows-executor-win32-x64`
 * 3. Archive / install layout (`bin/` next to package root or bundled entry)
 * 4. In-repo Cargo debug/release outputs (developer builds)
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_EXECUTOR_OPTIONAL_PACKAGE = '@gemslibe/rbo-windows-executor-win32-x64';
export const WINDOWS_EXECUTOR_BINARY_NAME = 'rbo-windows-executor.exe';

export type WindowsExecutorMissingReason = 'found' | 'non_windows' | 'wrong_arch' | 'not_installed';

export interface WindowsExecutorResolveResult {
  path: string | null;
  reason: WindowsExecutorMissingReason;
  detail: string;
}

export interface ResolveWindowsExecutorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Override existence check (tests). */
  existsSyncFn?: (path: string) => boolean;
  /** Override optional-package root lookup (tests). */
  resolveOptionalPackageRoot?: () => string | null;
  /** Extra candidate paths appended after built-in ones (tests / callers). */
  extraCandidates?: string[];
  /**
   * Anchor for relative archive / monorepo candidates.
   * Defaults to this module's directory (`import.meta.url`).
   */
  moduleDir?: string;
}

function defaultResolveOptionalPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve(`${WINDOWS_EXECUTOR_OPTIONAL_PACKAGE}/package.json`);
    return dirname(pkgJson);
  } catch {
    return null;
  }
}

/** v1 ships the helper for win32-x64 only. */
export function isSupportedWindowsExecutorHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === 'win32' && arch === 'x64';
}

export function resolveWindowsExecutorPath(
  options: ResolveWindowsExecutorOptions = {},
): string | null {
  return describeWindowsExecutorResolution(options).path;
}

export function describeWindowsExecutorResolution(
  options: ResolveWindowsExecutorOptions = {},
): WindowsExecutorResolveResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.existsSyncFn ?? existsSync;
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));

  const fromEnv = env.RBO_WINDOWS_EXECUTOR;
  if (fromEnv && exists(fromEnv)) {
    return {
      path: fromEnv,
      reason: 'found',
      detail: `RBO_WINDOWS_EXECUTOR=${fromEnv}`,
    };
  }

  const candidates: string[] = [];

  const resolvePkg = options.resolveOptionalPackageRoot ?? defaultResolveOptionalPackageRoot;
  const pkgRoot = resolvePkg();
  if (pkgRoot) {
    candidates.push(join(pkgRoot, 'bin', WINDOWS_EXECUTOR_BINARY_NAME));
    candidates.push(join(pkgRoot, WINDOWS_EXECUTOR_BINARY_NAME));
  }

  // Archive layout: packaging/*/MANIFEST ships bin/ next to other bins.
  // Bundled CLI lives at <root>/dist/rbo.js or <root>/bin/rbo.js.
  candidates.push(
    join(moduleDir, WINDOWS_EXECUTOR_BINARY_NAME),
    join(moduleDir, '..', WINDOWS_EXECUTOR_BINARY_NAME),
    join(moduleDir, '..', 'bin', WINDOWS_EXECUTOR_BINARY_NAME),
    join(moduleDir, '../..', 'bin', WINDOWS_EXECUTOR_BINARY_NAME),
  );

  // Monorepo developer builds (packages/executor/dist → repo root).
  // Prefer release over debug so a stale debug binary cannot shadow a fixed release build.
  candidates.push(
    join(
      moduleDir,
      '../../../native/windows-executor/target/release',
      WINDOWS_EXECUTOR_BINARY_NAME,
    ),
    join(moduleDir, '../../../native/windows-executor/target/debug', WINDOWS_EXECUTOR_BINARY_NAME),
    // When bundled into apps/cli/dist/rbo.js, climb to repo root.
    join(moduleDir, '../../native/windows-executor/target/release', WINDOWS_EXECUTOR_BINARY_NAME),
    join(moduleDir, '../../native/windows-executor/target/debug', WINDOWS_EXECUTOR_BINARY_NAME),
  );

  if (options.extraCandidates) {
    candidates.push(...options.extraCandidates);
  }

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return {
        path: candidate,
        reason: 'found',
        detail: candidate,
      };
    }
  }

  if (platform !== 'win32') {
    return {
      path: null,
      reason: 'non_windows',
      detail: `Windows Job Object helper (rbo-windows-executor.exe) is only shipped for win32-x64; current platform is ${platform}/${arch}`,
    };
  }
  if (arch !== 'x64') {
    return {
      path: null,
      reason: 'wrong_arch',
      detail: `Windows Job Object helper is win32-x64 only for v1; current arch is ${arch}. Install on x64 or set RBO_WINDOWS_EXECUTOR if you have a build.`,
    };
  }
  return {
    path: null,
    reason: 'not_installed',
    detail: `Optional package ${WINDOWS_EXECUTOR_OPTIONAL_PACKAGE} is missing or has no binary. Reinstall @gemslibe/rbo on Windows x64, or set RBO_WINDOWS_EXECUTOR to the exe path.`,
  };
}
