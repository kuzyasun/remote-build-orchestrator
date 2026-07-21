import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkNodeEngines,
  checkWindowsExecutor,
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

  it('fails node_engines when runtime is below >=22.14', async () => {
    const report = await runDoctor({
      dataDir: tempDir(),
      controllerUrl: null,
      nodeVersion: 'v20.11.0',
    });
    const check = report.checks.find((c) => c.name === 'node_engines');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/v20\.11\.0/);
    expect(report.ok).toBe(false);
  });

  it('passes node_engines at the minimum engines floor', () => {
    expect(checkNodeEngines('v22.14.0').ok).toBe(true);
    expect(checkNodeEngines('v22.15.1').ok).toBe(true);
    expect(checkNodeEngines('v23.0.0').ok).toBe(true);
    expect(checkNodeEngines('v22.13.9').ok).toBe(false);
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
