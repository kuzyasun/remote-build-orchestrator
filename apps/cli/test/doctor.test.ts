import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkControllerPorts,
  checkFirewall,
  checkMdnsPort,
  checkNodeEngines,
  checkWindowsExecutor,
  describeControllerReachabilityFailure,
  describeNetworkError,
  doctorStatusTag,
  evaluateLinuxFirewall,
  evaluateMacFirewall,
  evaluateWindowsFirewall,
  formatDoctorCheckLine,
  isWindowsFirewallActive,
  matchesPort,
  parseLsofTcp,
  parseLsofUdp,
  parseNetstatTcp,
  parseNetstatUdp,
  parseSsTcp,
  parseSsUdp,
  parseWindowsFirewallRules,
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

describe('doctor port parsing and conflict detection', () => {
  const sampleTcp = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200
  TCP    0.0.0.0:7410           0.0.0.0:0              LISTENING       54332
  TCP    0.0.0.0:7411           0.0.0.0:0              LISTENING       54332
  TCP    127.0.0.1:7410         0.0.0.0:0              LISTENING       54332
  TCP    [::]:7410              [::]:0                 LISTENING       54332
  TCP    192.168.0.102:50123    142.250.74.202:443     ESTABLISHED     1908
`;

  it('parses netstat TCP listening bindings', () => {
    const bindings = parseNetstatTcp(sampleTcp);
    expect(bindings.length).toBe(6);
    expect(bindings.find((b) => b.port === 7410 && b.host === '0.0.0.0')?.pid).toBe(54332);
    expect(bindings.find((b) => b.port === 7411)?.pid).toBe(54332);
    expect(bindings.find((b) => b.port === 50123)?.state).toBe('ESTABLISHED');
  });

  const sampleUdp = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:5353           *:*                                    19340
  UDP    0.0.0.0:5353           *:*                                    54332
  UDP    192.168.0.102:5353     *:*                                    46296
  UDP    [::]:5353              *:*                                    1908
`;

  it('parses netstat UDP bindings', () => {
    const bindings = parseNetstatUdp(sampleUdp);
    expect(bindings.length).toBe(4);
    expect(bindings.filter((b) => b.port === 5353).length).toBe(4);
    expect(bindings.find((b) => b.host === '192.168.0.102')?.pid).toBe(46296);
  });

  it('reports OK when controller is running and listening on 7410 and 7411', async () => {
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'win32',
      controllerPid: 54332,
      netstatTcpOutput: sampleTcp,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('7410');
    expect(check.detail).toContain('7411');
    expect(check.detail).toContain('54332');
  });

  it('fails when controller is running but port 7411 is stolen by a foreign process', async () => {
    const foreignTcp = `
  TCP    0.0.0.0:7410           0.0.0.0:0              LISTENING       54332
  TCP    0.0.0.0:7411           0.0.0.0:0              LISTENING       99999
`;
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'win32',
      controllerPid: 54332,
      netstatTcpOutput: foreignTcp,
      resolveProcessName: async (pid) => (pid === 99999 ? 'foreign_app.exe' : undefined),
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('port 7411 is occupied by "foreign_app.exe"');
    expect(check.detail).toContain('PID 99999');
  });

  it('reports OK when controller is not running and ports are free', async () => {
    const freeTcp = `
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200
`;
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'win32',
      controllerPid: null,
      netstatTcpOutput: freeTcp,
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toBe('ports 7410 and 7411 are available');
  });

  it('fails when controller is not running but port 7411 is already occupied', async () => {
    const occupiedTcp = `
  TCP    0.0.0.0:7411           0.0.0.0:0              LISTENING       8888
`;
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'win32',
      controllerPid: null,
      netstatTcpOutput: occupiedTcp,
      resolveProcessName: async () => 'busy_daemon.exe',
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('port 7411 is occupied by "busy_daemon.exe"');
  });
});

describe('doctor mDNS port binding diagnostics', () => {
  it('warns when a process is bound to a specific IP on UDP 5353 on Windows', async () => {
    const specificUdp = `
  UDP    0.0.0.0:5353           *:*                                    54332
  UDP    192.168.0.102:5353     *:*                                    46296
`;
    const check = await checkMdnsPort({
      platform: 'win32',
      netstatUdpOutput: specificUdp,
      resolveProcessName: async (pid) => (pid === 46296 ? 'Zoom.exe' : undefined),
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('Zoom.exe');
    expect(check.detail).toContain('192.168.0.102:5353');
    expect(check.detail).toContain('specific-IP');
  });

  it('reports OK when all mDNS listeners are on wildcard addresses (0.0.0.0, [::])', async () => {
    const cleanUdp = `
  UDP    0.0.0.0:5353           *:*                                    19340
  UDP    0.0.0.0:5353           *:*                                    54332
  UDP    [::]:5353              *:*                                    1908
`;
    const check = await checkMdnsPort({
      platform: 'win32',
      netstatUdpOutput: cleanUdp,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('shared across wildcard');
  });

  it('reports OK when UDP 5353 is completely free', async () => {
    const emptyUdp = `
  UDP    0.0.0.0:123            *:*                                    1200
`;
    const check = await checkMdnsPort({
      platform: 'win32',
      netstatUdpOutput: emptyUdp,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('UDP 5353 is available');
  });

  it('reports OK (interface-pinned) when specific-IP binding belongs to controller PID', async () => {
    const controllerOwnUdp = `
  UDP    0.0.0.0:5353           *:*                                    54332
  UDP    192.168.0.102:5353     *:*                                    42012
`;
    const check = await checkMdnsPort({
      platform: 'win32',
      netstatUdpOutput: controllerOwnUdp,
      controllerPid: 42012,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('interface-pinned');
    expect(check.detail).toContain('192.168.0.102:5353');
  });

  it('still warns when specific-IP binding belongs to a different process even with controllerPid', async () => {
    const mixedUdp = `
  UDP    0.0.0.0:5353           *:*                                    54332
  UDP    192.168.0.102:5353     *:*                                    46296
`;
    const check = await checkMdnsPort({
      platform: 'win32',
      netstatUdpOutput: mixedUdp,
      controllerPid: 42012,
      resolveProcessName: async (pid) => (pid === 46296 ? 'Zoom.exe' : undefined),
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('Zoom.exe');
  });
});

describe('doctor Windows Firewall diagnostics', () => {
  const fwDisabledOutput = `
Domain Profile Settings: 
State                                 OFF
Private Profile Settings: 
State                                 OFF
Public Profile Settings: 
State                                 OFF
`;

  const fwEnabledOutput = `
Domain Profile Settings: 
State                                 ON
Private Profile Settings: 
State                                 ON
Public Profile Settings: 
State                                 ON
`;

  it('detects when Windows Firewall is disabled across profiles', () => {
    expect(isWindowsFirewallActive(fwDisabledOutput)).toBe(false);
    expect(isWindowsFirewallActive(fwEnabledOutput)).toBe(true);
  });

  it('matches local ports including single, comma lists, ranges, and any', () => {
    expect(matchesPort('7411', 7411)).toBe(true);
    expect(matchesPort('7410,7411', 7411)).toBe(true);
    expect(matchesPort('7000-8000', 7411)).toBe(true);
    expect(matchesPort('Any', 7411)).toBe(true);
    expect(matchesPort('8080', 7411)).toBe(false);
    expect(matchesPort(undefined, 7411)).toBe(false);
  });

  const sampleRules = `
Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             TCP
Program:                              C:\\nvm4w\\nodejs\\node.exe
Action:                               Allow

Rule Name:                            Custom RBO Agent Plane
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private,Public
Protocol:                             TCP
LocalPort:                            7411
Action:                               Allow
`;

  it('parses Windows firewall rules', () => {
    const rules = parseWindowsFirewallRules(sampleRules);
    expect(rules.length).toBe(2);
    expect(rules[0].name).toBe('Node.js JavaScript Runtime');
    expect(rules[0].program).toBe('C:\\nvm4w\\nodejs\\node.exe');
    expect(rules[1].localPort).toBe('7411');
  });

  it('evaluates whether node or port 7411 is allowed', () => {
    const rules = parseWindowsFirewallRules(sampleRules);
    const evalAllowed = evaluateWindowsFirewall(rules, 'c:/nvm4w/nodejs/node.exe');
    expect(evalAllowed.nodeAllowed).toBe(true);
    expect(evalAllowed.port7411Allowed).toBe(true);

    const evalDifferentNode = evaluateWindowsFirewall(rules, 'c:/other/node.exe');
    expect(evalDifferentNode.nodeAllowed).toBe(false);
    expect(evalDifferentNode.port7411Allowed).toBe(true);
  });

  it('reports OK when firewall is disabled', async () => {
    const check = await checkFirewall({
      platform: 'win32',
      firewallStateOutput: fwDisabledOutput,
      firewallRulesOutput: '',
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('disabled');
  });

  it('reports OK when current node executable is allowed in firewall', async () => {
    const check = await checkFirewall({
      platform: 'win32',
      nodePath: 'C:\\nvm4w\\nodejs\\node.exe',
      firewallStateOutput: fwEnabledOutput,
      firewallRulesOutput: sampleRules,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain('inbound traffic allowed');
  });

  it('warns when neither node nor port 7411 is allowed in active firewall', async () => {
    const blockedRules = `
Rule Name:                            Some Other App
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             TCP
Program:                              C:\\program files\\other\\app.exe
Action:                               Allow
`;
    const check = await checkFirewall({
      platform: 'win32',
      nodePath: 'C:\\nvm4w\\nodejs\\node.exe',
      firewallStateOutput: fwEnabledOutput,
      firewallRulesOutput: blockedRules,
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('not allowed in Windows Defender Firewall');
    expect(check.detail).toContain('New-NetFirewallRule');
  });

  it('evaluates Linux firewall with ufw and firewalld', () => {
    // ufw active and allows 7411
    const ufwAllowed = `
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
7411/tcp                   ALLOW       Anywhere
`;
    expect(evaluateLinuxFirewall(ufwAllowed).ok).toBe(true);
    expect(evaluateLinuxFirewall(ufwAllowed).warn).toBeUndefined();
    expect(evaluateLinuxFirewall(ufwAllowed).detail).toContain(
      'inbound TCP 7411 is allowed in ufw',
    );

    // ufw active and blocks 7411
    const ufwBlocked = `
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
`;
    const ufwDiag = evaluateLinuxFirewall(ufwBlocked);
    expect(ufwDiag.ok).toBe(true);
    expect(ufwDiag.warn).toBe(true);
    expect(ufwDiag.detail).toContain('sudo ufw allow 7411/tcp');

    // firewalld active and allows 7411
    const fwCmdAllowed = evaluateLinuxFirewall(null, 'running', '7411/tcp 8080/tcp');
    expect(fwCmdAllowed.ok).toBe(true);
    expect(fwCmdAllowed.detail).toContain('inbound TCP 7411 is allowed in firewalld');

    // firewalld active and missing 7411
    const fwCmdBlocked = evaluateLinuxFirewall(null, 'running', '8080/tcp');
    expect(fwCmdBlocked.ok).toBe(true);
    expect(fwCmdBlocked.warn).toBe(true);
    expect(fwCmdBlocked.detail).toContain('sudo firewall-cmd --add-port=7411/tcp');

    // no active firewall
    const fwNone = evaluateLinuxFirewall(null, 'not running', null);
    expect(fwNone.ok).toBe(true);
    expect(fwNone.warn).toBeUndefined();
    expect(fwNone.detail).toContain('no active firewall');
  });

  it('evaluates macOS Application Firewall', () => {
    const disabled = 'Firewall is disabled. (State = 0)';
    expect(evaluateMacFirewall(disabled).ok).toBe(true);
    expect(evaluateMacFirewall(disabled).detail).toContain('disabled');

    const enabled = 'Firewall is enabled. (State = 1)';
    const enabledDiag = evaluateMacFirewall(enabled);
    expect(enabledDiag.ok).toBe(true);
    expect(enabledDiag.warn).toBe(true);
    expect(enabledDiag.detail).toContain('System Settings');
  });

  it('runs checkFirewall for Linux and macOS via injected outputs', async () => {
    const linuxCheck = await checkFirewall({
      platform: 'linux',
      linuxUfwOutput: 'Status: inactive',
      linuxFirewalldStateOutput: 'not running',
    });
    expect(linuxCheck.ok).toBe(true);
    expect(linuxCheck.detail).toContain('no active firewall');

    const macCheck = await checkFirewall({
      platform: 'darwin',
      macFirewallOutput: 'Firewall is disabled. (State = 0)',
    });
    expect(macCheck.ok).toBe(true);
    expect(macCheck.detail).toContain('disabled');

    const freebsdCheck = await checkFirewall({
      platform: 'freebsd',
    });
    expect(freebsdCheck.ok).toBe(true);
    expect(freebsdCheck.detail).toContain('skipped');
  });
});

describe('cross-platform ss and lsof parsing (Linux and macOS)', () => {
  const sampleSsTcp = `
LISTEN 0 128 0.0.0.0:7410 0.0.0.0:* users:(("node",pid=1234,fd=18))
LISTEN 0 128 *:7411 *:* users:(("node",pid=1234,fd=19))
`;

  const sampleSsUdp = `
UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* users:(("avahi-daemon",pid=600,fd=12))
UNCONN 0 0 192.168.1.10:5353 0.0.0.0:* users:(("zoom",pid=4567,fd=15))
`;

  it('parses Linux ss TCP output', () => {
    const bindings = parseSsTcp(sampleSsTcp);
    expect(bindings.length).toBe(2);
    expect(bindings[0].port).toBe(7410);
    expect(bindings[0].pid).toBe(1234);
    expect(bindings[1].port).toBe(7411);
    expect(bindings[1].pid).toBe(1234);
  });

  it('parses Linux ss UDP output and detects specific-IP bindings', async () => {
    const bindings = parseSsUdp(sampleSsUdp);
    expect(bindings.length).toBe(2);
    expect(bindings[0].host).toBe('0.0.0.0');
    expect(bindings[1].host).toBe('192.168.1.10');
    expect(bindings[1].pid).toBe(4567);

    const check = await checkMdnsPort({
      platform: 'linux',
      ssUdpOutput: sampleSsUdp,
      resolveProcessName: async (pid) => (pid === 4567 ? 'zoom' : undefined),
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('zoom');
    expect(check.detail).toContain('192.168.1.10:5353');
  });

  const sampleLsofTcp = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node     1234 user   18u  IPv4 0x1234      0t0  TCP *:7410 (LISTEN)
node     1234 user   19u  IPv4 0x1235      0t0  TCP *:7411 (LISTEN)
`;

  const sampleLsofUdp = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
mDNSRespo 200 _mdns  10u  IPv4 0x1234      0t0  UDP *:5353
Zoom     4567 user   12u  IPv4 0x1236      0t0  UDP 192.168.1.50:5353
`;

  it('parses macOS lsof TCP output', () => {
    const bindings = parseLsofTcp(sampleLsofTcp);
    expect(bindings.length).toBe(2);
    expect(bindings[0].port).toBe(7410);
    expect(bindings[0].pid).toBe(1234);
    expect(bindings[1].port).toBe(7411);
    expect(bindings[1].pid).toBe(1234);
  });

  it('parses macOS lsof UDP output and detects specific-IP bindings', async () => {
    const bindings = parseLsofUdp(sampleLsofUdp);
    expect(bindings.length).toBe(2);
    expect(bindings[0].host).toBe('*');
    expect(bindings[1].host).toBe('192.168.1.50');
    expect(bindings[1].pid).toBe(4567);

    const check = await checkMdnsPort({
      platform: 'darwin',
      lsofUdpOutput: sampleLsofUdp,
      resolveProcessName: async (pid) => (pid === 4567 ? 'Zoom' : undefined),
    });
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('Zoom');
    expect(check.detail).toContain('192.168.1.50:5353');
  });

  it('verifies checkControllerPorts on Linux using ssTcpOutput', async () => {
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'linux',
      controllerPid: 1234,
      ssTcpOutput: sampleSsTcp,
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('7410');
    expect(check.detail).toContain('7411');
  });

  it('verifies checkControllerPorts on macOS using lsofTcpOutput', async () => {
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'darwin',
      controllerPid: 1234,
      lsofTcpOutput: sampleLsofTcp,
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('7410');
    expect(check.detail).toContain('7411');
  });

  it('correctly rejects Windows node.exe allow rule when Protocol is UDP', () => {
    const udpNodeRule = `
Rule Name:                            Node mDNS UDP
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             UDP
Program:                              C:\\nvm4w\\nodejs\\node.exe
Action:                               Allow
`;
    const rules = parseWindowsFirewallRules(udpNodeRule);
    const evalRes = evaluateWindowsFirewall(rules, 'C:\\nvm4w\\nodejs\\node.exe');
    expect(evalRes.nodeAllowed).toBe(false);
    expect(evalRes.port5353Allowed).toBe(false); // No port specified
  });

  it('handles macOS firewall null output as warning instead of disabled', async () => {
    const diag = evaluateMacFirewall(null);
    expect(diag.ok).toBe(true);
    expect(diag.warn).toBe(true);
    expect(diag.detail).toContain('unable to query');
  });

  it('parses lsof output with spaces in command name', () => {
    const lsofWithSpaces = `
COMMAND          PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
Google Chrome   5678 user   18u  IPv4 0x1234      0t0  TCP *:7410 (LISTEN)
RBO Daemon       999 user   19u  IPv4 0x1235      0t0  UDP 192.168.1.1:5353
`;
    const tcp = parseLsofTcp(lsofWithSpaces);
    expect(tcp.length).toBe(1);
    expect(tcp[0].pid).toBe(5678);
    expect(tcp[0].port).toBe(7410);

    const udp = parseLsofUdp(lsofWithSpaces);
    expect(udp.length).toBe(1);
    expect(udp[0].pid).toBe(999);
    expect(udp[0].port).toBe(5353);
    expect(udp[0].host).toBe('192.168.1.1');
  });

  it('detects unprivileged foreign socket PID 0 on port 7411 on Linux', async () => {
    const ssWithPid0On7411 = `
LISTEN 0 128 127.0.0.1:7410 0.0.0.0:* users:(("node",pid=1234,fd=18))
LISTEN 0 128 0.0.0.0:7411 0.0.0.0:*
`;
    const check = await checkControllerPorts({
      dataDir: tempDir(),
      platform: 'linux',
      controllerPid: 1234,
      ssTcpOutput: ssWithPid0On7411,
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('port 7411 is occupied');
    expect(check.detail).toContain('unprivileged socket');
  });
});
