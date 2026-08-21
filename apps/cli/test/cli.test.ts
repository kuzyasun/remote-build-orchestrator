import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runControllerFingerprint, runControllerInit } from '../src/commands/controller.js';
import { formatCliHelp } from '../src/commands/help.js';
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

describe('rbo --help', () => {
  it('lists top-level commands and version', () => {
    const help = formatCliHelp();
    expect(help).toMatch(/^rbo CLI v/);
    expect(help).toContain('controller start');
    expect(help).toContain('agent stop-process');
    expect(help).toContain('doctor');
    expect(help).toContain('--replace');
    expect(help).toContain('run [options] -- <shell-command-string>');
    expect(help).toContain('--follow                 Stream live logs until the job completes');
    expect(help).toContain('not an argv-safe direct execution API');
  });
});

describe('rbo controller init / fingerprint (§33)', () => {
  it('init generates identity and fingerprint reads it back out-of-band', async () => {
    const dataDir = tempDir();
    const initResult = await runControllerInit({ dataDir });
    expect(initResult.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(initResult.configPath).toBe(join(dataDir, 'controller.json'));
    expect(initResult.configWritten).toBe(true);
    expect(existsSync(initResult.configPath)).toBe(true);

    const fpResult = await runControllerFingerprint({ dataDir });
    expect(fpResult.fingerprint).toBe(initResult.fingerprint);
  });

  it('init is idempotent: a second call keeps the same fingerprint', async () => {
    const dataDir = tempDir();
    const first = await runControllerInit({ dataDir });
    const second = await runControllerInit({ dataDir });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.configWritten).toBe(false);
  });

  it('init writes controller.json and does not overwrite edits', async () => {
    const dataDir = tempDir();
    const first = await runControllerInit({ dataDir });
    const configPath = first.configPath;
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcp_port: number;
      allowed_project_roots: string[];
    };
    expect(written.mcp_port).toBe(7410);
    expect(written.allowed_project_roots).toEqual([]);

    writeFileSync(configPath, '{"mcp_port":9999,"allowed_project_roots":["C:/kept"]}\n', 'utf8');
    const second = await runControllerInit({ dataDir });
    expect(second.configWritten).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(
      '{"mcp_port":9999,"allowed_project_roots":["C:/kept"]}\n',
    );
  });

  it('init --force rewrites controller.json', async () => {
    const dataDir = tempDir();
    await runControllerInit({ dataDir });
    const configPath = join(dataDir, 'controller.json');
    writeFileSync(configPath, '{"mcp_port":1}\n', 'utf8');
    const forced = await runControllerInit({ dataDir, force: true });
    expect(forced.configWritten).toBe(true);
    const rewritten = JSON.parse(readFileSync(configPath, 'utf8')) as { mcp_port: number };
    expect(rewritten.mcp_port).toBe(7410);
  });
});

describe('rbo agent install plan (§33)', () => {
  it('renders a Windows Service install plan on win32', () => {
    const plan = renderServiceInstallPlan('win32', {
      nodePath: 'C:/nodejs/node.exe',
      rboScriptPath: 'C:/rbo/rbo.js',
      stateDir: 'C:/rbo-state/agent',
    });
    expect(plan.kind).toBe('windows_service');
    expect(plan.commands.join(' ')).toMatch(/sc(\.exe)?\s+create/i);
    expect(plan.commands.join(' ')).toMatch(/rbo\.js/);
    expect(plan.commands.join(' ')).toMatch(/agent start/);
    expect(plan.commands.join(' ')).not.toMatch(/Program Files|rbo-agent\.exe/i);
  });

  it('renders a launchd plan on darwin', () => {
    const plan = renderServiceInstallPlan('darwin');
    expect(plan.kind).toBe('launchd');
    expect(plan.commands.join(' ')).toMatch(/launchctl/i);
    expect(plan.commands.join(' ')).toMatch(/rbo\.js|agent start/);
  });

  it('renders a systemd plan on linux', () => {
    const plan = renderServiceInstallPlan('linux');
    expect(plan.kind).toBe('systemd');
    expect(plan.commands.join(' ')).toMatch(/systemctl/i);
    expect(plan.commands.join(' ')).toMatch(/rbo\.js|agent start/);
  });

  it('detects the current platform', () => {
    expect(['win32', 'darwin', 'linux']).toContain(detectPlatform(process.platform));
  });
});
