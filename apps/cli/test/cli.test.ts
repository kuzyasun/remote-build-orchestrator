import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runControllerFingerprint, runControllerInit } from '../src/commands/controller.js';
import { detectPlatform, renderServiceInstallPlan } from '../src/commands/service.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-cli-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('rbo controller init / fingerprint (§33, Phase 2)', () => {
  it('init generates identity and fingerprint reads it back out-of-band', async () => {
    const dataDir = tempDir();
    const initResult = await runControllerInit({ dataDir });
    expect(initResult.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const fpResult = await runControllerFingerprint({ dataDir });
    expect(fpResult.fingerprint).toBe(initResult.fingerprint);
  });

  it('init is idempotent: a second call keeps the same fingerprint', async () => {
    const dataDir = tempDir();
    const first = await runControllerInit({ dataDir });
    const second = await runControllerInit({ dataDir });
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe('rbo agent install plan (§33, Phase 2)', () => {
  it('renders a Windows Service install plan on win32', () => {
    const plan = renderServiceInstallPlan('win32');
    expect(plan.kind).toBe('windows_service');
    expect(plan.commands.join(' ')).toMatch(/sc(\.exe)?\s+create/i);
  });

  it('renders a launchd plan on darwin', () => {
    const plan = renderServiceInstallPlan('darwin');
    expect(plan.kind).toBe('launchd');
    expect(plan.commands.join(' ')).toMatch(/launchctl/i);
  });

  it('renders a systemd plan on linux', () => {
    const plan = renderServiceInstallPlan('linux');
    expect(plan.kind).toBe('systemd');
    expect(plan.commands.join(' ')).toMatch(/systemctl/i);
  });

  it('detects the current platform', () => {
    expect(['win32', 'darwin', 'linux']).toContain(detectPlatform(process.platform));
  });
});
