import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkNodeEngines,
  checkWindowsExecutor,
  describeControllerReachabilityFailure,
  describeNetworkError,
  doctorStatusTag,
  formatDoctorCheckLine,
  runDoctor,
} from '../src/commands/doctor.js';

/** Strip CSI SGR sequences so assertions work with or without ANSI. */
const ESC = '\u001b';
function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-doctor-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('rbo doctor (§33)', () => {
  it('reports git, data dir permissions and shell checks with ok/detail per item', async () => {
    const dataDir = tempDir();
    const report = await runDoctor({ dataDir, controllerUrl: null });

    const names = report.checks.map((c) => c.name);
    expect(names).toContain('node_engines');
    expect(names).toContain('git');
    expect(names).toContain('data_dir_writable');
    expect(names).toContain('shell_executables');
    expect(names).toContain('windows_executor');

    for (const check of report.checks) {
      expect(typeof check.ok).toBe('boolean');
      expect(typeof check.detail).toBe('string');
    }
  });

  it('fails node_engines when runtime is below >=24.0', async () => {
    const report = await runDoctor({
      dataDir: tempDir(),
      controllerUrl: null,
      nodeVersion: 'v22.14.0',
    });
    const check = report.checks.find((c) => c.name === 'node_engines');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/v22\.14\.0/);
    expect(report.ok).toBe(false);
  });

  it('passes node_engines at the minimum engines floor', () => {
    expect(checkNodeEngines('v24.0.0').ok).toBe(true);
    expect(checkNodeEngines('v24.1.0').ok).toBe(true);
    expect(checkNodeEngines('v25.0.0').ok).toBe(true);
    expect(checkNodeEngines('v23.9.0').ok).toBe(false);
    expect(checkNodeEngines('v22.14.0').ok).toBe(false);
  });

  it('marks data_dir_writable false when the directory cannot be created', async () => {
    // A path nested under a file (not a directory) can never be created.
    const dataDir = join(tempDir(), 'blocked-file', 'nested');
    const report = await runDoctor({ dataDir: '\0invalid', controllerUrl: null });
    const check = report.checks.find((c) => c.name === 'data_dir_writable');
    expect(check?.ok).toBe(false);
  });

  it('includes a controller_reachable check only when a controller URL is given', async () => {
    const withUrl = await runDoctor({ dataDir: tempDir(), controllerUrl: 'http://127.0.0.1:1' });
    expect(withUrl.checks.map((c) => c.name)).toContain('controller_reachable');

    const withoutUrl = await runDoctor({ dataDir: tempDir(), controllerUrl: null });
    expect(withoutUrl.checks.map((c) => c.name)).not.toContain('controller_reachable');
  });

  it('overall ok is false if any check fails', async () => {
    const report = await runDoctor({ dataDir: tempDir(), controllerUrl: 'http://127.0.0.1:1' });
    const reachable = report.checks.find((c) => c.name === 'controller_reachable');
    expect(reachable?.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(reachable?.detail).toContain('http://127.0.0.1:1');
    expect(reachable?.detail).not.toMatch(/TypeError: fetch failed/);
    // Node/undici may reject port 1 as `bad port` instead of connecting.
    expect(reachable?.detail).toMatch(/bad port|ECONNREFUSED|ECONNRESET|timed out/i);
  }, 15_000);

  it('warns for windows_executor when helper is missing (non-Windows)', async () => {
    const report = await runDoctor({
      dataDir: tempDir(),
      controllerUrl: null,
      windowsExecutorResolve: {
        env: {},
        platform: 'linux',
        arch: 'x64',
        existsSyncFn: () => false,
        resolveOptionalPackageRoot: () => null,
        moduleDir: join('tmp'),
      },
    });
    const check = report.checks.find((c) => c.name === 'windows_executor');
    expect(check?.ok).toBe(true);
    expect(check?.warn).toBe(true);
    expect(check?.detail).toMatch(/win32-x64/);
    // Advisory warn must not fail overall doctor when other checks pass.
    expect(report.checks.filter((c) => c.name === 'windows_executor').every((c) => c.ok)).toBe(
      true,
    );
  });

  it('warns for wrong arch and failed optional install', () => {
    const wrongArch = checkWindowsExecutor({
      path: null,
      reason: 'wrong_arch',
      detail: 'Windows Job Object helper is win32-x64 only for v1; current arch is arm64.',
    });
    expect(wrongArch.warn).toBe(true);
    expect(wrongArch.ok).toBe(true);
    expect(wrongArch.detail).toMatch(/arm64/);

    const missing = checkWindowsExecutor({
      path: null,
      reason: 'not_installed',
      detail: 'Optional package @gemslibe/rbo-windows-executor-win32-x64 is missing',
    });
    expect(missing.warn).toBe(true);
    expect(missing.detail).toMatch(/optional package/i);
  });

  it('reports OK when windows executor path is found', () => {
    const path = join('pkg', 'bin', 'rbo-windows-executor.exe');
    const check = checkWindowsExecutor({
      path,
      reason: 'found',
      detail: path,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toBe(path);
  });
});

function systemError(init: {
  code: string;
  syscall?: string;
  address?: string;
  port?: number;
  message?: string;
}): NodeJS.ErrnoException {
  const error = new Error(
    init.message ?? `${init.syscall ?? 'connect'} ${init.code} ${init.address ?? ''}`,
  ) as NodeJS.ErrnoException;
  error.code = init.code;
  error.syscall = init.syscall;
  error.address = init.address;
  error.port = init.port;
  return error;
}

function fetchFailed(cause: unknown): TypeError {
  const error = new TypeError('fetch failed');
  error.cause = cause;
  return error;
}

describe('controller reachability error details', () => {
  it('unwraps undici TypeError: fetch failed to the system cause', () => {
    const wrapped = fetchFailed(
      systemError({
        code: 'ECONNREFUSED',
        syscall: 'connect',
        address: '127.0.0.1',
        port: 7410,
      }),
    );
    expect(describeNetworkError(wrapped)).toBe('connect ECONNREFUSED 127.0.0.1:7410');
    expect(describeControllerReachabilityFailure(wrapped, 'http://127.0.0.1:7410')).toMatch(
      /^http:\/\/127\.0\.0\.1:7410: connect ECONNREFUSED 127\.0\.0\.1:7410\. Controller HTTP is not listening/,
    );
    expect(describeControllerReachabilityFailure(wrapped, 'http://127.0.0.1:7410')).not.toContain(
      'TypeError: fetch failed',
    );
  });

  it('walks AggregateError.errors used by dual-stack connect', () => {
    const wrapped = fetchFailed(
      new AggregateError(
        [
          systemError({ code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 7410 }),
          systemError({
            code: 'ECONNREFUSED',
            syscall: 'connect',
            address: '127.0.0.1',
            port: 7410,
          }),
        ],
        'fetch failed',
      ),
    );
    expect(describeNetworkError(wrapped)).toMatch(/ECONNREFUSED/);
  });

  it('reports probe timeout instead of AbortError name', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(describeNetworkError(timeout)).toBe('timed out after 2s');
    expect(describeControllerReachabilityFailure(timeout, 'http://192.168.0.102:7410')).toContain(
      'port 7410 is CLI/MCP',
    );
  });

  it('hints that remote :7410 timeouts are often loopback-only HTTP', () => {
    const wrapped = fetchFailed(
      systemError({
        code: 'ETIMEDOUT',
        syscall: 'connect',
        address: '192.168.0.102',
        port: 7410,
      }),
    );
    const detail = describeControllerReachabilityFailure(wrapped, 'http://192.168.0.102:7410');
    expect(detail).toContain('connect ETIMEDOUT 192.168.0.102:7410');
    expect(detail).toContain('RBO_CONTROLLER_URL_HTTP');
    expect(detail).toContain(':7411');
  });

  it('reports ENOTFOUND without the fetch-failed wrapper', () => {
    const wrapped = fetchFailed(
      systemError({
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        address: 'no-such-controller.local',
        message: 'getaddrinfo ENOTFOUND no-such-controller.local',
      }),
    );
    expect(
      describeControllerReachabilityFailure(wrapped, 'http://no-such-controller.local:7410'),
    ).toMatch(/ENOTFOUND.*hostname did not resolve/s);
  });
});

describe('doctor status line formatting', () => {
  it('maps check outcomes to fixed-width tags', () => {
    expect(doctorStatusTag({ name: 'a', ok: true, detail: 'x' })).toBe('OK  ');
    expect(doctorStatusTag({ name: 'a', ok: false, detail: 'x' })).toBe('FAIL');
    expect(doctorStatusTag({ name: 'a', ok: true, warn: true, detail: 'x' })).toBe('WARN');
  });

  it('prints plain tags when color is disabled', () => {
    expect(
      formatDoctorCheckLine({ name: 'git', ok: true, detail: 'git version 2' }, { color: false }),
    ).toBe('OK   git: git version 2');
    expect(
      formatDoctorCheckLine(
        { name: 'controller_reachable', ok: false, detail: 'fetch failed' },
        { color: false },
      ),
    ).toBe('FAIL controller_reachable: fetch failed');
    expect(
      formatDoctorCheckLine(
        { name: 'windows_executor', ok: true, warn: true, detail: 'missing' },
        { color: false },
      ),
    ).toBe('WARN windows_executor: missing');
  });

  it('colorizes OK / FAIL / WARN tags when color is forced', () => {
    const ok = formatDoctorCheckLine({ name: 'git', ok: true, detail: 'ok' }, { color: true });
    const fail = formatDoctorCheckLine(
      { name: 'controller_reachable', ok: false, detail: 'down' },
      { color: true },
    );
    const warn = formatDoctorCheckLine(
      { name: 'windows_executor', ok: true, warn: true, detail: 'advisory' },
      { color: true },
    );

    expect(ok).toContain(`${ESC}[`);
    expect(fail).toContain(`${ESC}[`);
    expect(warn).toContain(`${ESC}[`);
    expect(stripAnsi(ok)).toBe('OK   git: ok');
    expect(stripAnsi(fail)).toBe('FAIL controller_reachable: down');
    expect(stripAnsi(warn)).toBe('WARN windows_executor: advisory');
    // Distinct SGR color codes: green / red / yellow
    expect(ok).toContain(`${ESC}[32mOK  ${ESC}[39m`);
    expect(fail).toContain(`${ESC}[31mFAIL${ESC}[39m`);
    expect(warn).toContain(`${ESC}[33mWARN${ESC}[39m`);
  });
});
