import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_EXECUTOR_BINARY_NAME,
  WINDOWS_EXECUTOR_OPTIONAL_PACKAGE,
  describeWindowsExecutorResolution,
  isSupportedWindowsExecutorHost,
  resolveWindowsExecutorPath,
} from '../src/windows-executor-path.js';

describe('resolveWindowsExecutorPath', () => {
  it('prefers RBO_WINDOWS_EXECUTOR when the path exists', () => {
    const envPath = join('C:', 'helpers', WINDOWS_EXECUTOR_BINARY_NAME);
    const result = describeWindowsExecutorResolution({
      env: { RBO_WINDOWS_EXECUTOR: envPath },
      existsSyncFn: (p) => p === envPath,
      resolveOptionalPackageRoot: () => null,
      moduleDir: join('unused'),
      platform: 'linux',
      arch: 'x64',
    });
    expect(result.reason).toBe('found');
    expect(result.path).toBe(envPath);
  });

  it('resolves from the optional npm package bin/ layout', () => {
    const pkgRoot = join('tmp', 'node_modules', '@gemslibe', 'rbo-windows-executor-win32-x64');
    const exe = join(pkgRoot, 'bin', WINDOWS_EXECUTOR_BINARY_NAME);
    const result = describeWindowsExecutorResolution({
      env: {},
      existsSyncFn: (p) => p === exe,
      resolveOptionalPackageRoot: () => pkgRoot,
      moduleDir: join('unused'),
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.reason).toBe('found');
    expect(result.path).toBe(exe);
  });

  it('resolves archive bin/ layout relative to moduleDir', () => {
    const moduleDir = join('opt', 'rbo', 'dist');
    const exe = join('opt', 'rbo', 'bin', WINDOWS_EXECUTOR_BINARY_NAME);
    const result = describeWindowsExecutorResolution({
      env: {},
      existsSyncFn: (p) => p === exe,
      resolveOptionalPackageRoot: () => null,
      moduleDir,
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.reason).toBe('found');
    expect(result.path).toBe(exe);
  });

  it('reports non_windows when helper is absent off Windows', () => {
    const result = describeWindowsExecutorResolution({
      env: {},
      existsSyncFn: () => false,
      resolveOptionalPackageRoot: () => null,
      moduleDir: join('tmp'),
      platform: 'linux',
      arch: 'x64',
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe('non_windows');
    expect(result.detail).toMatch(/win32-x64/);
  });

  it('reports wrong_arch on win32 non-x64', () => {
    const result = describeWindowsExecutorResolution({
      env: {},
      existsSyncFn: () => false,
      resolveOptionalPackageRoot: () => null,
      moduleDir: join('tmp'),
      platform: 'win32',
      arch: 'arm64',
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe('wrong_arch');
    expect(result.detail).toMatch(/arm64/);
  });

  it('reports not_installed on win32-x64 when package/binary missing', () => {
    const result = describeWindowsExecutorResolution({
      env: {},
      existsSyncFn: () => false,
      resolveOptionalPackageRoot: () => null,
      moduleDir: join('tmp'),
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe('not_installed');
    expect(result.detail).toContain(WINDOWS_EXECUTOR_OPTIONAL_PACKAGE);
  });

  it('resolveWindowsExecutorPath returns null when missing', () => {
    expect(
      resolveWindowsExecutorPath({
        env: {},
        existsSyncFn: () => false,
        resolveOptionalPackageRoot: () => null,
        moduleDir: join('tmp'),
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBeNull();
  });

  it('isSupportedWindowsExecutorHost is win32-x64 only', () => {
    expect(isSupportedWindowsExecutorHost('win32', 'x64')).toBe(true);
    expect(isSupportedWindowsExecutorHost('win32', 'arm64')).toBe(false);
    expect(isSupportedWindowsExecutorHost('linux', 'x64')).toBe(false);
  });
});
