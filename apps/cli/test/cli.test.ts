import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatControllerList, selectBestAddress } from '../src/commands/agent.js';
import { runControllerFingerprint, runControllerInit } from '../src/commands/controller.js';
import { formatTable, runDiscover } from '../src/commands/discover.js';
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
    expect(help).toContain('agent reject [<pairing-request-id>]');
    expect(help).toContain('agent approve [<pairing-request-id>]');
    expect(help).toContain('agent init [--force] [--skip-discovery]');
    expect(help).toContain('discover');
    expect(help).toContain('doctor');
    expect(help).toContain('--replace');
    expect(help).toContain('run [options] -- <shell-command-string>');
    expect(help).toContain('--follow                 Stream live logs until the job completes');
    expect(help).toContain('Remote execution timeout, not a CLI wait deadline');
    expect(help).toContain('bash|zsh|sh|powershell|pwsh|cmd|direct');
    expect(help).toContain('non-interactive runs\nexit 125 with confirmation instructions');
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

describe('mDNS CLI formatting (§7.2)', () => {
  const dummyControllers = [
    {
      name: 'ctrl-alpha',
      host: 'alpha.local',
      addresses: ['192.168.1.10', 'fe80::1'],
      port: 7411,
      controllerId: 'controller_01JALPHA',
      fingerprint: 'sha256:1122334455667788',
      version: '1',
    },
    {
      name: 'ctrl-beta',
      host: 'beta.local',
      addresses: ['192.168.1.20'],
      port: 7411,
      controllerId: 'controller_01JBETA',
      fingerprint: 'sha256:aabbccddeeff0011',
      version: '1',
    },
  ];

  it('formatControllerList renders numbered entries and skip option', () => {
    const text = formatControllerList(dummyControllers);
    expect(text).toContain('1) ctrl-alpha (192.168.1.10:7411)');
    expect(text).toContain('controller_01JALPHA  fingerprint: sha256:1122334455667788');
    expect(text).toContain('2) ctrl-beta (192.168.1.20:7411)');
    expect(text).toContain('controller_01JBETA  fingerprint: sha256:aabbccddeeff0011');
    expect(text).toContain('0) Skip — configure manually later');
  });

  it('formatTable renders column headers and formatted rows without truncating fingerprints or IPv6', () => {
    const table = formatTable(dummyControllers);
    expect(table).toContain('Name');
    expect(table).toContain('Address');
    expect(table).toContain('Port');
    expect(table).toContain('Controller ID');
    expect(table).toContain('Fingerprint');
    expect(table).toContain('ctrl-alpha');
    expect(table).toContain('192.168.1.10');
    expect(table).toContain('7411');
    expect(table).toContain('controller_01JALPHA');
    expect(table).toContain('sha256:1122334455667788');

    const ipv6Controller = [
      {
        name: 'ctrl-ipv6',
        host: 'ipv6.local',
        addresses: ['fe80::1ff:fe23:4567:890a'],
        port: 7411,
        controllerId: 'controller_01JIPV6TEST',
        fingerprint: 'sha256:998877665544332211',
        version: '1',
      },
    ];
    const ipv6Table = formatTable(ipv6Controller);
    expect(ipv6Table).toContain('ipv6.local');
  });

  describe('selectBestAddress', () => {
    it('prefers 192.168.x.x LAN over docker bridge 172.17.0.1', () => {
      const best = selectBestAddress(['172.17.0.1', '192.168.1.50'], 'fallback.local');
      expect(best).toBe('192.168.1.50');
    });

    it('prefers 10.x.x.x LAN over APIPA 169.254.x.x', () => {
      const best = selectBestAddress(['169.254.10.20', '10.0.0.15'], 'fallback.local');
      expect(best).toBe('10.0.0.15');
    });

    it('filters out loopback and link-local IPv6', () => {
      const best = selectBestAddress(['127.0.0.1', 'fe80::1', '192.168.1.2'], 'fallback.local');
      expect(best).toBe('192.168.1.2');
    });

    it('falls back to fallbackHost when all addresses are link-local or loopback', () => {
      const best = selectBestAddress(['169.254.1.2', 'fe80::1', '127.0.0.1'], 'myhost.local');
      expect(best).toBe('myhost.local');
    });

    it('falls back to fallbackHost when addresses array is empty', () => {
      const best = selectBestAddress([], 'ctrl.local');
      expect(best).toBe('ctrl.local');
    });

    it('prefers routable IPv4 responderAddress over 192.168.x.x host-only interface', () => {
      const best = selectBestAddress(['192.168.56.1', '10.0.0.42'], 'ctrl.local', '10.0.0.42');
      expect(best).toBe('10.0.0.42');
    });

    it('ignores link-local IPv6 responderAddress and uses routable address from list', () => {
      const best = selectBestAddress(['10.0.0.42'], 'ctrl.local', 'fe80::1234');
      expect(best).toBe('10.0.0.42');
    });

    it('ignores loopback responderAddress and uses routable address from list', () => {
      const best = selectBestAddress(['10.0.0.42'], 'ctrl.local', '127.0.0.1');
      expect(best).toBe('10.0.0.42');
    });
  });

  describe('runDiscover', () => {
    it('outputs JSON when json option is true', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const results = await runDiscover({ json: true });
        expect(consoleLogSpy).toHaveBeenCalled();
        const jsonOutput = consoleLogSpy.mock.calls[0]?.[0];
        expect(() => JSON.parse(jsonOutput)).not.toThrow();
      } finally {
        consoleLogSpy.mockRestore();
      }
    });
  });
});
