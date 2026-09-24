import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify, styleText } from 'node:util';
import {
  type ResolveWindowsExecutorOptions,
  type WindowsExecutorResolveResult,
  describeWindowsExecutorResolution,
} from '@rbo/executor';
import { resolveControllerDataDir } from '@rbo/shared';
import { controllerPidPath, isProcessAlive } from './daemon.js';

const execFileAsync = promisify(execFile);

/** Minimum Node.js version declared by `@gemslibe/rbo` engines. */
export const REQUIRED_NODE_ENGINES = { major: 24, minor: 0 } as const;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Advisory finding — printed as WARN; does not fail overall report.ok. */
  warn?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  dataDir: string;
  controllerUrl: string | null;
  /** Injected for unit tests of the windows-executor check. */
  windowsExecutorResolve?: ResolveWindowsExecutorOptions;
  /** Injected Node version string (e.g. `v24.0.0`) for engines tests. */
  nodeVersion?: string;
  /** Injected platform for cross-platform tests (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Injected controller PID for testing controller_ports. */
  controllerPid?: number | null;
  /** Injected TCP netstat output for testing controller_ports. */
  netstatTcpOutput?: string;
  /** Injected UDP netstat output for testing mdns_port. */
  netstatUdpOutput?: string;
  /** Injected ss TCP output for testing Linux. */
  ssTcpOutput?: string;
  /** Injected ss UDP output for testing Linux. */
  ssUdpOutput?: string;
  /** Injected lsof TCP output for testing macOS/Linux. */
  lsofTcpOutput?: string;
  /** Injected lsof UDP output for testing macOS/Linux. */
  lsofUdpOutput?: string;
  /** Injected process name resolver for testing. */
  processNameResolver?: ProcessNameResolver;
  /** Injected node binary path for testing firewall rules. */
  nodePath?: string;
  /** Injected Windows firewall state output for testing. */
  firewallStateOutput?: string;
  /** Injected Windows firewall rules output for testing. */
  firewallRulesOutput?: string;
  /** Injected Linux ufw output for testing. */
  linuxUfwOutput?: string | null;
  /** Injected Linux firewalld state output for testing. */
  linuxFirewalldStateOutput?: string | null;
  /** Injected Linux firewalld ports output for testing. */
  linuxFirewalldPortsOutput?: string | null;
  /** Injected macOS firewall output for testing. */
  macFirewallOutput?: string | null;
}

/** Status tag printed by `rbo doctor` (fixed width for column alignment). */
export type DoctorStatusTag = 'OK  ' | 'FAIL' | 'WARN';

export function doctorStatusTag(check: DoctorCheck): DoctorStatusTag {
  if (!check.ok) return 'FAIL';
  if (check.warn) return 'WARN';
  return 'OK  ';
}

export interface FormatDoctorCheckLineOptions {
  /**
   * Force ANSI on (`true`) or off (`false`).
   * When omitted, `util.styleText` decides via TTY + `NO_COLOR` / `FORCE_COLOR`.
   */
  color?: boolean;
  /** Stream used for auto color detection (default: `process.stdout`). */
  stream?: NodeJS.WriteStream;
}

/**
 * One doctor report line: colored status tag + check name + detail.
 * Colors are green (OK), red (FAIL), yellow (WARN). Disabled when not a TTY,
 * when `NO_COLOR` / `NODE_DISABLE_COLORS` is set, or when `color: false`.
 */
export function formatDoctorCheckLine(
  check: DoctorCheck,
  options: FormatDoctorCheckLineOptions = {},
): string {
  const tag = doctorStatusTag(check);
  const colorName = !check.ok ? 'red' : check.warn ? 'yellow' : 'green';
  const styledTag =
    options.color === false
      ? tag
      : styleText(colorName, tag, {
          stream: options.stream ?? process.stdout,
          validateStream: options.color !== true,
        });
  return `${styledTag} ${check.name}: ${check.detail}`;
}

async function checkGit(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    return { name: 'git', ok: true, detail: stdout.trim() };
  } catch (error) {
    return { name: 'git', ok: false, detail: `git not found: ${String(error)}` };
  }
}

function checkDataDirWritable(dataDir: string): DoctorCheck {
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, '.rbo-doctor-probe');
    writeFileSync(probe, 'ok');
    return { name: 'data_dir_writable', ok: true, detail: dataDir };
  } catch (error) {
    return { name: 'data_dir_writable', ok: false, detail: String(error) };
  }
}

async function checkShellExecutables(): Promise<DoctorCheck> {
  const candidates =
    process.platform === 'win32'
      ? [
          ['powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']],
          ['cmd.exe', ['/c', 'ver']],
        ]
      : [
          ['bash', ['--version']],
          ['sh', ['-c', 'echo ok']],
        ];

  const found: string[] = [];
  for (const [cmd, args] of candidates) {
    try {
      await execFileAsync(cmd as string, args as string[]);
      found.push(cmd as string);
    } catch {
      // shell not present — not fatal on its own
    }
  }
  return {
    name: 'shell_executables',
    ok: found.length > 0,
    detail: found.length > 0 ? `available: ${found.join(', ')}` : 'no supported shell found',
  };
}

/** Health probe budget used by `controller_reachable` and its timeout wording. */
export const CONTROLLER_HEALTH_TIMEOUT_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk `cause` and AggregateError `errors` so undici's wrapper `TypeError: fetch failed`
 * is not the only string operator-facing checks can print.
 */
function flattenErrorChain(error: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    out.push(current);
    if ('cause' in current) {
      stack.push(current.cause);
    }
    if (Array.isArray(current.errors)) {
      for (let i = current.errors.length - 1; i >= 0; i -= 1) {
        stack.push(current.errors[i]);
      }
    }
  }
  return out;
}

function errorCode(entry: Record<string, unknown>): string | undefined {
  return typeof entry.code === 'string' && entry.code.length > 0 ? entry.code : undefined;
}

function isAbortTimeout(entry: Record<string, unknown>): boolean {
  const name = typeof entry.name === 'string' ? entry.name : '';
  const message = typeof entry.message === 'string' ? entry.message : '';
  return (
    name === 'TimeoutError' ||
    entry.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    (name === 'AbortError' && /timeout/i.test(message))
  );
}

function formatSystemError(entry: Record<string, unknown>): string {
  const code = errorCode(entry);
  const syscall = typeof entry.syscall === 'string' ? entry.syscall : undefined;
  const address = typeof entry.address === 'string' ? entry.address : undefined;
  const port = typeof entry.port === 'number' ? entry.port : undefined;
  const host = address !== undefined && port !== undefined ? `${address}:${port}` : address;
  const parts = [syscall, code, host].filter((part): part is string => Boolean(part));
  if (parts.length > 0) {
    return parts.join(' ');
  }
  const message = typeof entry.message === 'string' ? entry.message.trim() : '';
  if (code && message && message !== 'fetch failed') {
    return `${code}: ${message}`;
  }
  if (code) {
    return code;
  }
  return message;
}

/**
 * Prefer the underlying system / undici error over Node's generic `fetch failed`.
 */
export function describeNetworkError(error: unknown): string {
  const chain = flattenErrorChain(error);
  if (chain.some((entry) => isAbortTimeout(entry))) {
    return `timed out after ${CONTROLLER_HEALTH_TIMEOUT_MS / 1000}s`;
  }

  const withCode = [...chain].reverse().find((entry) => errorCode(entry));
  if (withCode) {
    return formatSystemError(withCode);
  }

  for (const entry of [...chain].reverse()) {
    const message = typeof entry.message === 'string' ? entry.message.trim() : '';
    if (message && message !== 'fetch failed') {
      return message;
    }
  }

  return String(error);
}

function parsedPort(controllerUrl: string): string | null {
  try {
    const port = new URL(controllerUrl).port;
    return port.length > 0 ? port : null;
  } catch {
    return null;
  }
}

function reachabilityHint(controllerUrl: string, cause: string): string | null {
  if (/ECONNREFUSED/.test(cause)) {
    return 'Controller HTTP is not listening; start it with `rbo controller start --daemon`';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(cause)) {
    return 'hostname did not resolve';
  }
  if (/CERT|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/.test(cause)) {
    return 'TLS certificate could not be verified';
  }
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out/.test(cause)) {
    const port = parsedPort(controllerUrl);
    if (port === '7410') {
      return 'port 7410 is CLI/MCP and is usually loopback-only; Agents use :7411. Set RBO_CONTROLLER_URL_HTTP to reach a remote Controller, or run doctor on the Controller host';
    }
    return 'host unreachable, firewall dropped the packet, or the Controller is not bound on this address';
  }
  return null;
}

/** Operator-facing detail for a failed Controller HTTP health probe. */
export function describeControllerReachabilityFailure(
  error: unknown,
  controllerUrl: string,
): string {
  const cause = describeNetworkError(error);
  const hint = reachabilityHint(controllerUrl, cause);
  return hint ? `${controllerUrl}: ${cause}. ${hint}` : `${controllerUrl}: ${cause}`;
}

async function checkControllerReachable(controllerUrl: string): Promise<DoctorCheck> {
  const base = controllerUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/internal/v1/health`, {
      signal: AbortSignal.timeout(CONTROLLER_HEALTH_TIMEOUT_MS),
    });
    return {
      name: 'controller_reachable',
      ok: res.ok,
      detail: res.ok ? controllerUrl : `${controllerUrl} returned HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      name: 'controller_reachable',
      ok: false,
      detail: describeControllerReachabilityFailure(error, controllerUrl),
    };
  }
}

/**
 * FAIL when the running Node is below `@gemslibe/rbo` engines (`>=24.0`).
 */
export function checkNodeEngines(nodeVersion: string = process.version): DoctorCheck {
  const required = `>=${REQUIRED_NODE_ENGINES.major}.${REQUIRED_NODE_ENGINES.minor}`;
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion);
  if (!match) {
    return {
      name: 'node_engines',
      ok: false,
      detail: `unparseable Node version ${nodeVersion}; require ${required}`,
    };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const ok =
    major > REQUIRED_NODE_ENGINES.major ||
    (major === REQUIRED_NODE_ENGINES.major && minor >= REQUIRED_NODE_ENGINES.minor);
  return {
    name: 'node_engines',
    ok,
    detail: ok
      ? `${nodeVersion} satisfies engines ${required}`
      : `${nodeVersion} is below engines ${required}`,
  };
}

/**
 * Warn when the Windows Job Object helper is missing (non-Windows, wrong arch,
 * or failed optional install). Never fails overall doctor — Job Objects are
 * Windows-x64-only containment; other hosts run without the helper by design.
 */
export function checkWindowsExecutor(
  resolution?: WindowsExecutorResolveResult,
  resolveOptions?: ResolveWindowsExecutorOptions,
): DoctorCheck {
  const result = resolution ?? describeWindowsExecutorResolution(resolveOptions);
  if (result.reason === 'found' && result.path) {
    return {
      name: 'windows_executor',
      ok: true,
      detail: result.path,
    };
  }
  return {
    name: 'windows_executor',
    ok: true,
    warn: true,
    detail: result.detail,
  };
}

export interface TcpPortBinding {
  host: string;
  port: number;
  state: string;
  pid: number;
}

export function parseNetstatTcp(output: string): TcpPortBinding[] {
  const bindings: TcpPortBinding[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.toUpperCase().startsWith('TCP')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddr = parts[1];
    const state = parts[3];
    const pid = Number.parseInt(parts[4], 10);
    if (Number.isNaN(pid)) continue;
    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const host = localAddr.slice(0, lastColon);
    const port = Number.parseInt(localAddr.slice(lastColon + 1), 10);
    if (Number.isNaN(port)) continue;
    bindings.push({ host, port, state, pid });
  }
  return bindings;
}

export interface UdpPortBinding {
  host: string;
  port: number;
  pid: number;
}

export function parseNetstatUdp(output: string): UdpPortBinding[] {
  const bindings: UdpPortBinding[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.toUpperCase().startsWith('UDP')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const localAddr = parts[1];
    const pid = Number.parseInt(parts[3], 10);
    if (Number.isNaN(pid)) continue;
    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const host = localAddr.slice(0, lastColon);
    const port = Number.parseInt(localAddr.slice(lastColon + 1), 10);
    if (Number.isNaN(port)) continue;
    bindings.push({ host, port, pid });
  }
  return bindings;
}

export function parseSsTcp(output: string): TcpPortBinding[] {
  const bindings: TcpPortBinding[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !/LISTEN/i.test(line)) continue;
    const pidMatch = line.match(/pid=(\d+)/i);
    const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : 0;
    const parts = line.split(/\s+/);
    const addrPart = parts.find((p) => p.includes(':') && !p.startsWith('users:'));
    if (!addrPart) continue;
    const lastColon = addrPart.lastIndexOf(':');
    if (lastColon === -1) continue;
    const host = addrPart.slice(0, lastColon);
    const port = Number.parseInt(addrPart.slice(lastColon + 1), 10);
    if (Number.isNaN(port)) continue;
    bindings.push({ host, port, state: 'LISTENING', pid });
  }
  return bindings;
}

export function parseSsUdp(output: string): UdpPortBinding[] {
  const bindings: UdpPortBinding[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const pidMatch = line.match(/pid=(\d+)/i);
    const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : 0;
    const parts = line.split(/\s+/);
    const addrPart = parts.find((p) => p.includes(':') && !p.startsWith('users:'));
    if (!addrPart) continue;
    const lastColon = addrPart.lastIndexOf(':');
    if (lastColon === -1) continue;
    const host = addrPart.slice(0, lastColon);
    const port = Number.parseInt(addrPart.slice(lastColon + 1), 10);
    if (Number.isNaN(port)) continue;
    bindings.push({ host, port, pid });
  }
  return bindings;
}

export function parseLsofTcp(output: string): TcpPortBinding[] {
  const bindings: TcpPortBinding[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('COMMAND')) continue;
    const parts = line.split(/\s+/);
    const tcpIdx = parts.findIndex((p) => p.toUpperCase() === 'TCP');
    if (tcpIdx === -1 || parts.length <= tcpIdx + 1) continue;
    const pidIdx = parts.findIndex((p, idx) => idx > 0 && idx < tcpIdx && /^\d+$/.test(p));
    const pid = pidIdx !== -1 ? Number.parseInt(parts[pidIdx], 10) : 0;
    const addr = parts[tcpIdx + 1];
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const host = addr.slice(0, lastColon);
    const port = Number.parseInt(addr.slice(lastColon + 1), 10);
    if (Number.isNaN(port)) continue;
    const state =
      parts
        .slice(tcpIdx + 2)
        .join(' ')
        .replace(/[()]/g, '') || 'LISTENING';
    bindings.push({ host, port, state, pid });
  }
  return bindings;
}

export function parseLsofUdp(output: string): UdpPortBinding[] {
  const bindings: UdpPortBinding[] = [];
  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('COMMAND')) continue;
    const parts = line.split(/\s+/);
    const udpIdx = parts.findIndex((p) => p.toUpperCase() === 'UDP');
    if (udpIdx === -1 || parts.length <= udpIdx + 1) continue;
    const pidIdx = parts.findIndex((p, idx) => idx > 0 && idx < udpIdx && /^\d+$/.test(p));
    const pid = pidIdx !== -1 ? Number.parseInt(parts[pidIdx], 10) : 0;
    const addr = parts[udpIdx + 1];
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const host = addr.slice(0, lastColon);
    const port = Number.parseInt(addr.slice(lastColon + 1), 10);
    if (Number.isNaN(port)) continue;
    bindings.push({ host, port, pid });
  }
  return bindings;
}

export interface InboundFirewallRule {
  name: string;
  enabled: boolean;
  action: 'Allow' | 'Block';
  program?: string;
  protocol?: string;
  localPort?: string;
}

export function parseWindowsFirewallRules(output: string): InboundFirewallRule[] {
  const rules: InboundFirewallRule[] = [];
  const blocks = output.split(/(?=Rule Name:\s*)/i);
  for (const block of blocks) {
    const nameMatch = block.match(/Rule Name:\s*([^\r\n]+)/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const enabledMatch = block.match(/Enabled:\s*([^\r\n]+)/i);
    const enabled = enabledMatch ? /yes/i.test(enabledMatch[1].trim()) : false;

    const actionMatch = block.match(/Action:\s*([^\r\n]+)/i);
    const action = actionMatch && /allow/i.test(actionMatch[1].trim()) ? 'Allow' : 'Block';

    const programMatch = block.match(/Program:\s*([^\r\n]+)/i);
    const program = programMatch ? programMatch[1].trim() : undefined;

    const protocolMatch = block.match(/Protocol:\s*([^\r\n]+)/i);
    const protocol = protocolMatch ? protocolMatch[1].trim() : undefined;

    const portMatch = block.match(/LocalPort:\s*([^\r\n]+)/i);
    const localPort = portMatch ? portMatch[1].trim() : undefined;

    rules.push({ name, enabled, action, program, protocol, localPort });
  }
  return rules;
}

export function isWindowsFirewallActive(showAllProfilesOutput: string): boolean {
  return /State\s+ON/i.test(showAllProfilesOutput);
}

export function matchesPort(localPortStr: string | undefined, targetPort: number): boolean {
  if (!localPortStr) return false;
  const lower = localPortStr.toLowerCase().trim();
  if (lower === 'any') return true;
  const parts = lower.split(',').map((p) => p.trim());
  for (const part of parts) {
    if (part === String(targetPort)) return true;
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const min = Number.parseInt(rangeMatch[1], 10);
      const max = Number.parseInt(rangeMatch[2], 10);
      if (targetPort >= min && targetPort <= max) return true;
    }
  }
  return false;
}

export interface FirewallCheckResult {
  nodeAllowed: boolean;
  port7411Allowed: boolean;
  port5353Allowed: boolean;
}

export function evaluateWindowsFirewall(
  rules: InboundFirewallRule[],
  nodeExecutablePath: string,
): FirewallCheckResult {
  const normNode = nodeExecutablePath.toLowerCase().replace(/\\/g, '/');
  let nodeAllowed = false;
  let port7411Allowed = false;
  let port5353Allowed = false;

  for (const rule of rules) {
    if (!rule.enabled || rule.action !== 'Allow') continue;

    const normProg = rule.program ? rule.program.toLowerCase().replace(/\\/g, '/') : undefined;
    const isProgramRule = Boolean(normProg && normProg !== 'any');
    const matchesNode = normProg === normNode;

    // If the rule specifies a different program, it does not allow traffic for node.exe
    if (isProgramRule && !matchesNode) {
      continue;
    }

    const proto = (rule.protocol ?? '').toUpperCase();
    const isTcpOrAny = proto === 'TCP' || proto === 'ANY' || proto === '';

    if (matchesNode && isTcpOrAny) {
      // If rule allows node.exe without restricting to specific non-7411 ports
      if (!rule.localPort || matchesPort(rule.localPort, 7411)) {
        nodeAllowed = true;
      }
    }

    if (proto === 'TCP' || proto === 'ANY') {
      if (matchesPort(rule.localPort, 7411)) {
        port7411Allowed = true;
      }
    }

    if (proto === 'UDP' || proto === 'ANY') {
      if (matchesPort(rule.localPort, 5353)) {
        port5353Allowed = true;
      }
    }
  }

  return { nodeAllowed, port7411Allowed, port5353Allowed };
}

export interface FirewallDiagnosis {
  ok: boolean;
  warn?: boolean;
  detail: string;
}

export function evaluateLinuxFirewall(
  ufwStatus?: string | null,
  firewalldState?: string | null,
  firewalldPorts?: string | null,
): FirewallDiagnosis {
  if (ufwStatus && /Status:\s*active/i.test(ufwStatus)) {
    if (/\b7411(?:\/tcp)?\b.*ALLOW/i.test(ufwStatus)) {
      return {
        ok: true,
        detail: 'inbound TCP 7411 is allowed in ufw',
      };
    }
    return {
      ok: true,
      warn: true,
      detail:
        'ufw is active but port 7411/tcp is not allowed; remote agents may not be able to connect. Run: sudo ufw allow 7411/tcp',
    };
  }

  if (firewalldState && /^running$/i.test(firewalldState.trim())) {
    if (firewalldPorts && /\b7411\/tcp\b/i.test(firewalldPorts)) {
      return {
        ok: true,
        detail: 'inbound TCP 7411 is allowed in firewalld',
      };
    }
    return {
      ok: true,
      warn: true,
      detail:
        'firewalld is active but port 7411/tcp is not allowed; remote agents may not be able to connect. Run: sudo firewall-cmd --add-port=7411/tcp --permanent && sudo firewall-cmd --reload',
    };
  }

  return {
    ok: true,
    detail: 'no active firewall blocking ports detected (ufw/firewalld inactive or not installed)',
  };
}

export function evaluateMacFirewall(socketfilterfwOutput?: string | null): FirewallDiagnosis {
  if (socketfilterfwOutput === null || socketfilterfwOutput === undefined) {
    return {
      ok: true,
      warn: true,
      detail: 'unable to query macOS Application Firewall (socketfilterfw unavailable or failed)',
    };
  }
  if (/State\s*=\s*0|disabled/i.test(socketfilterfwOutput)) {
    return {
      ok: true,
      detail: 'macOS Application Firewall is disabled',
    };
  }
  if (/State\s*=\s*1|enabled/i.test(socketfilterfwOutput)) {
    return {
      ok: true,
      warn: true,
      detail:
        'macOS Application Firewall is enabled; ensure incoming connections are allowed for Node.js in System Settings > Network > Firewall',
    };
  }
  return {
    ok: true,
    detail: 'macOS Application Firewall is inactive',
  };
}

export type ProcessNameResolver = (pid: number) => Promise<string | undefined>;

export async function defaultProcessNameResolver(pid: number): Promise<string | undefined> {
  if (pid <= 0) return undefined;
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeout: 3000 },
      );
      const match = stdout.trim().match(/^"([^"]+)"/);
      if (match?.[1] && !match[1].startsWith('INFO:')) {
        return match[1];
      }
    } catch {
      // Ignore tasklist failure
    }
  } else {
    try {
      if (existsSync(`/proc/${pid}/comm`)) {
        return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      }
    } catch {
      // Ignore /proc failure
    }
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
        timeout: 3000,
      });
      const name = stdout.trim();
      if (name) {
        const lastSlash = name.lastIndexOf('/');
        return lastSlash !== -1 ? name.slice(lastSlash + 1) : name;
      }
    } catch {
      // Ignore ps failure
    }
  }
  return undefined;
}

function readLiveControllerPid(dataDir: string): number | null {
  const dirs = [dataDir];
  try {
    const defaultDataDir = resolveControllerDataDir();
    if (defaultDataDir !== dataDir) {
      dirs.push(defaultDataDir);
    }
  } catch {
    // Ignore error resolving default data dir
  }

  for (const dir of dirs) {
    try {
      const pidFile = controllerPidPath(dir);
      if (existsSync(pidFile)) {
        const raw = readFileSync(pidFile, 'utf8').trim();
        const pid = Number.parseInt(raw, 10);
        if (isProcessAlive(pid)) {
          return pid;
        }
      }
    } catch {
      // Continue to next dir
    }
  }
  return null;
}

export interface CheckControllerPortsOptions {
  dataDir: string;
  platform?: NodeJS.Platform;
  controllerPid?: number | null;
  netstatTcpOutput?: string;
  ssTcpOutput?: string;
  lsofTcpOutput?: string;
  resolveProcessName?: ProcessNameResolver;
}

export async function checkControllerPorts(
  options: CheckControllerPortsOptions,
): Promise<DoctorCheck> {
  const platform = options.platform ?? process.platform;
  const controllerPid =
    options.controllerPid !== undefined
      ? options.controllerPid
      : readLiveControllerPid(options.dataDir);

  let bindings: TcpPortBinding[] | undefined;
  if (options.netstatTcpOutput !== undefined) {
    bindings = parseNetstatTcp(options.netstatTcpOutput);
  } else if (options.ssTcpOutput !== undefined) {
    bindings = parseSsTcp(options.ssTcpOutput);
  } else if (options.lsofTcpOutput !== undefined) {
    bindings = parseLsofTcp(options.lsofTcpOutput);
  } else if (platform === 'win32') {
    try {
      const res = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 5000 });
      bindings = parseNetstatTcp(res.stdout);
    } catch {
      // netstat unavailable
    }
  } else if (platform === 'linux') {
    try {
      const res = await execFileAsync('ss', ['-H', '-tlpn'], { timeout: 5000 });
      bindings = parseSsTcp(res.stdout);
    } catch {
      // ss failed, try lsof
    }
    if (!bindings) {
      try {
        const res = await execFileAsync('lsof', ['-iTCP:7410,7411', '-sTCP:LISTEN', '-n', '-P'], {
          timeout: 5000,
        });
        bindings = parseLsofTcp(res.stdout);
      } catch {
        // lsof failed
      }
    }
  } else {
    // macOS or other Unix
    try {
      const res = await execFileAsync('lsof', ['-iTCP:7410,7411', '-sTCP:LISTEN', '-n', '-P'], {
        timeout: 5000,
      });
      bindings = parseLsofTcp(res.stdout);
    } catch {
      // lsof failed
    }
  }

  if (bindings === undefined) {
    return {
      name: 'controller_ports',
      ok: true,
      detail: 'port check skipped (ss/lsof/netstat unavailable on this platform)',
    };
  }

  const listening = bindings.filter((b) => b.state.toUpperCase() === 'LISTENING');
  const p7410 = listening.find((b) => b.port === 7410);
  const p7411 = listening.find((b) => b.port === 7411);

  const resolveName = options.resolveProcessName ?? defaultProcessNameResolver;

  // Case 1: Controller is running (controllerPid is known and alive)
  if (controllerPid) {
    const p7411Conflicting =
      p7411 && (p7411.pid !== 0 ? p7411.pid !== controllerPid : p7410?.pid === controllerPid);
    if (p7411Conflicting) {
      const name =
        p7411.pid === 0
          ? 'another user or system process'
          : ((await resolveName(p7411.pid)) ?? `PID ${p7411.pid}`);
      const pidDesc = p7411.pid === 0 ? 'unprivileged socket' : `PID ${p7411.pid}`;
      return {
        name: 'controller_ports',
        ok: false,
        detail: `port 7411 is occupied by "${name}" (${pidDesc}) instead of Controller (PID ${controllerPid})`,
      };
    }

    const p7410Conflicting =
      p7410 && (p7410.pid !== 0 ? p7410.pid !== controllerPid : p7411?.pid === controllerPid);
    if (p7410Conflicting) {
      const name =
        p7410.pid === 0
          ? 'another user or system process'
          : ((await resolveName(p7410.pid)) ?? `PID ${p7410.pid}`);
      const pidDesc = p7410.pid === 0 ? 'unprivileged socket' : `PID ${p7410.pid}`;
      return {
        name: 'controller_ports',
        ok: false,
        detail: `port 7410 is occupied by "${name}" (${pidDesc}) instead of Controller (PID ${controllerPid})`,
      };
    }
    if (p7410 && p7411) {
      return {
        name: 'controller_ports',
        ok: true,
        detail: `Controller listening on TCP 7410 (HTTP) and 7411 (agent plane) (PID ${controllerPid})`,
      };
    }
    if (p7410 && !p7411) {
      return {
        name: 'controller_ports',
        ok: true,
        warn: true,
        detail: `Controller (PID ${controllerPid}) is listening on TCP 7410, but agent plane (7411) is not active`,
      };
    }
    return {
      name: 'controller_ports',
      ok: true,
      warn: true,
      detail: `Controller process is alive (PID ${controllerPid}), but ports 7410 and 7411 are not yet listening`,
    };
  }

  // Case 2: controllerPid not explicitly known, but both ports are listening by same process (e.g. foreground controller)
  if (p7410 && p7411 && p7410.pid === p7411.pid && p7410.pid !== 0) {
    return {
      name: 'controller_ports',
      ok: true,
      detail: `Controller listening on TCP 7410 (HTTP) and 7411 (agent plane) (PID ${p7410.pid})`,
    };
  }

  // Case 3: Controller is NOT running
  if (p7411) {
    const name = (await resolveName(p7411.pid)) ?? `PID ${p7411.pid}`;
    return {
      name: 'controller_ports',
      ok: false,
      detail: `port 7411 is occupied by "${name}" (PID ${p7411.pid}); Controller will fail to bind`,
    };
  }
  if (p7410) {
    const name = (await resolveName(p7410.pid)) ?? `PID ${p7410.pid}`;
    return {
      name: 'controller_ports',
      ok: false,
      detail: `port 7410 is occupied by "${name}" (PID ${p7410.pid}); Controller will fail to bind`,
    };
  }

  return {
    name: 'controller_ports',
    ok: true,
    detail: 'ports 7410 and 7411 are available',
  };
}

export interface CheckMdnsPortOptions {
  platform?: NodeJS.Platform;
  netstatUdpOutput?: string;
  ssUdpOutput?: string;
  lsofUdpOutput?: string;
  resolveProcessName?: ProcessNameResolver;
  /** Known Controller PID — its own specific-IP mDNS binding is not a conflict. */
  controllerPid?: number | null;
}

export async function checkMdnsPort(options: CheckMdnsPortOptions = {}): Promise<DoctorCheck> {
  const platform = options.platform ?? process.platform;
  let bindings: UdpPortBinding[] | undefined;

  if (options.netstatUdpOutput !== undefined) {
    bindings = parseNetstatUdp(options.netstatUdpOutput);
  } else if (options.ssUdpOutput !== undefined) {
    bindings = parseSsUdp(options.ssUdpOutput);
  } else if (options.lsofUdpOutput !== undefined) {
    bindings = parseLsofUdp(options.lsofUdpOutput);
  } else if (platform === 'win32') {
    try {
      const res = await execFileAsync('netstat', ['-ano', '-p', 'udp'], { timeout: 5000 });
      bindings = parseNetstatUdp(res.stdout);
    } catch {
      // netstat unavailable
    }
  } else if (platform === 'linux') {
    try {
      const res = await execFileAsync('ss', ['-H', '-ulpn'], { timeout: 5000 });
      bindings = parseSsUdp(res.stdout);
    } catch {
      // ss failed, try lsof
    }
    if (!bindings) {
      try {
        const res = await execFileAsync('lsof', ['-iUDP:5353', '-n', '-P'], { timeout: 5000 });
        bindings = parseLsofUdp(res.stdout);
      } catch {
        // lsof failed
      }
    }
  } else {
    // macOS or other Unix
    try {
      const res = await execFileAsync('lsof', ['-iUDP:5353', '-n', '-P'], { timeout: 5000 });
      bindings = parseLsofUdp(res.stdout);
    } catch {
      // lsof failed
    }
  }

  if (bindings === undefined) {
    return {
      name: 'mdns_port',
      ok: true,
      detail: 'mDNS port check skipped (ss/lsof/netstat unavailable on this platform)',
    };
  }

  const mdnsBindings = bindings.filter((b) => b.port === 5353);

  if (mdnsBindings.length === 0) {
    return {
      name: 'mdns_port',
      ok: true,
      detail: 'UDP 5353 is available for discovery',
    };
  }

  const isWildcard = (host: string) =>
    host === '0.0.0.0' || host === '*' || host === '::' || host === '[::]';

  const controllerPid = options.controllerPid ?? null;

  const conflicting = mdnsBindings.find(
    (b) => !isWildcard(b.host) && (controllerPid === null || b.pid !== controllerPid),
  );
  if (conflicting) {
    const resolveName = options.resolveProcessName ?? defaultProcessNameResolver;
    const name = (await resolveName(conflicting.pid)) ?? `PID ${conflicting.pid}`;
    return {
      name: 'mdns_port',
      ok: true,
      warn: true,
      detail: `process "${name}" (PID ${conflicting.pid}) is bound to ${conflicting.host}:5353; specific-IP UDP bindings can intercept mDNS discovery packets for 0.0.0.0:5353 (close ${name} to restore auto-discovery)`,
    };
  }

  // Controller's own specific-IP binding is intentional (interface pinning)
  const ownBinding = mdnsBindings.find(
    (b) => !isWildcard(b.host) && controllerPid !== null && b.pid === controllerPid,
  );
  if (ownBinding) {
    return {
      name: 'mdns_port',
      ok: true,
      detail: `Controller mDNS bound to ${ownBinding.host}:5353 (interface-pinned, ${mdnsBindings.length} listener${mdnsBindings.length === 1 ? '' : 's'})`,
    };
  }

  return {
    name: 'mdns_port',
    ok: true,
    detail: `UDP 5353 shared across wildcard (0.0.0.0) without conflicting specific-IP bindings (${mdnsBindings.length} listener${mdnsBindings.length === 1 ? '' : 's'})`,
  };
}

export interface CheckFirewallOptions {
  platform?: NodeJS.Platform;
  nodePath?: string;
  firewallStateOutput?: string;
  firewallRulesOutput?: string;
  linuxUfwOutput?: string | null;
  linuxFirewalldStateOutput?: string | null;
  linuxFirewalldPortsOutput?: string | null;
  macFirewallOutput?: string | null;
}

export async function checkFirewall(options: CheckFirewallOptions = {}): Promise<DoctorCheck> {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;

  if (platform === 'win32') {
    let stateOutput = options.firewallStateOutput;
    let rulesOutput = options.firewallRulesOutput;

    if (stateOutput === undefined || rulesOutput === undefined) {
      try {
        const [stateRes, rulesRes] = await Promise.all([
          execFileAsync('netsh', ['advfirewall', 'show', 'allprofiles', 'state'], {
            timeout: 5000,
          }),
          execFileAsync(
            'netsh',
            ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'],
            { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
          ),
        ]);
        stateOutput = stateRes.stdout;
        rulesOutput = rulesRes.stdout;
      } catch (error) {
        return {
          name: 'firewall',
          ok: true,
          warn: true,
          detail: `unable to query Windows Firewall: ${String(error)}`,
        };
      }
    }

    if (!isWindowsFirewallActive(stateOutput)) {
      return {
        name: 'firewall',
        ok: true,
        detail: 'Windows Defender Firewall is disabled',
      };
    }

    const rules = parseWindowsFirewallRules(rulesOutput);
    const evalResult = evaluateWindowsFirewall(rules, nodePath);

    if (evalResult.nodeAllowed) {
      return {
        name: 'firewall',
        ok: true,
        detail: `inbound traffic allowed for "${nodePath}" in Windows Defender Firewall`,
      };
    }

    if (evalResult.port7411Allowed) {
      return {
        name: 'firewall',
        ok: true,
        detail: 'inbound TCP 7411 is allowed in Windows Defender Firewall',
      };
    }

    return {
      name: 'firewall',
      ok: true,
      warn: true,
      detail: `inbound TCP 7411 or "${nodePath}" not allowed in Windows Defender Firewall; remote agents may not be able to connect. Run: New-NetFirewallRule -DisplayName "RBO Controller" -Direction Inbound -Program "${nodePath}" -Action Allow`,
    };
  }

  if (platform === 'linux') {
    let ufwOut = options.linuxUfwOutput;
    let fwCmdState = options.linuxFirewalldStateOutput;
    let fwCmdPorts = options.linuxFirewalldPortsOutput;

    if (ufwOut === undefined && fwCmdState === undefined) {
      try {
        const res = await execFileAsync('ufw', ['status'], { timeout: 3000 });
        ufwOut = res.stdout;
      } catch {
        ufwOut = null;
      }
      if (!ufwOut || !/Status:\s*active/i.test(ufwOut)) {
        try {
          const stateRes = await execFileAsync('firewall-cmd', ['--state'], { timeout: 3000 });
          fwCmdState = stateRes.stdout.trim();
          if (/^running$/i.test(fwCmdState)) {
            const portsRes = await execFileAsync('firewall-cmd', ['--list-ports'], {
              timeout: 3000,
            });
            fwCmdPorts = portsRes.stdout.trim();
          }
        } catch {
          fwCmdState = null;
          fwCmdPorts = null;
        }
      }
    }

    const diagnosis = evaluateLinuxFirewall(ufwOut, fwCmdState, fwCmdPorts);
    return {
      name: 'firewall',
      ok: diagnosis.ok,
      warn: diagnosis.warn,
      detail: diagnosis.detail,
    };
  }

  if (platform === 'darwin') {
    let macOut = options.macFirewallOutput;
    if (macOut === undefined) {
      try {
        const res = await execFileAsync(
          '/usr/libexec/ApplicationFirewall/socketfilterfw',
          ['--getglobalstate'],
          { timeout: 3000 },
        );
        macOut = res.stdout;
      } catch {
        macOut = null;
      }
    }

    const diagnosis = evaluateMacFirewall(macOut);
    return {
      name: 'firewall',
      ok: diagnosis.ok,
      warn: diagnosis.warn,
      detail: diagnosis.detail,
    };
  }

  return {
    name: 'firewall',
    ok: true,
    detail: `${platform} firewall check skipped`,
  };
}

// `rbo doctor` (§33): git, controller port reachability, data dir permissions
// and shell executables run locally; database/compression/TLS/snapshot checks
// arrive with their respective phases (§35).
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const [controllerPorts, mdnsPort, firewall] = await Promise.all([
    checkControllerPorts({
      dataDir: options.dataDir,
      platform: options.platform,
      controllerPid: options.controllerPid,
      netstatTcpOutput: options.netstatTcpOutput,
      ssTcpOutput: options.ssTcpOutput,
      lsofTcpOutput: options.lsofTcpOutput,
      resolveProcessName: options.processNameResolver,
    }),
    checkMdnsPort({
      platform: options.platform,
      netstatUdpOutput: options.netstatUdpOutput,
      ssUdpOutput: options.ssUdpOutput,
      lsofUdpOutput: options.lsofUdpOutput,
      resolveProcessName: options.processNameResolver,
      controllerPid: options.controllerPid,
    }),
    checkFirewall({
      platform: options.platform,
      nodePath: options.nodePath,
      firewallStateOutput: options.firewallStateOutput,
      firewallRulesOutput: options.firewallRulesOutput,
      linuxUfwOutput: options.linuxUfwOutput,
      linuxFirewalldStateOutput: options.linuxFirewalldStateOutput,
      linuxFirewalldPortsOutput: options.linuxFirewalldPortsOutput,
      macFirewallOutput: options.macFirewallOutput,
    }),
  ]);

  const checks: DoctorCheck[] = [
    checkNodeEngines(options.nodeVersion),
    await checkGit(),
    checkDataDirWritable(options.dataDir),
    await checkShellExecutables(),
    checkWindowsExecutor(undefined, options.windowsExecutorResolve),
    controllerPorts,
    mdnsPort,
    firewall,
  ];

  if (options.controllerUrl) {
    checks.push(await checkControllerReachable(options.controllerUrl));
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}
