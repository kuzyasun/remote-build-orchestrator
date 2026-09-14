import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify, styleText } from 'node:util';
import {
  type ResolveWindowsExecutorOptions,
  type WindowsExecutorResolveResult,
  describeWindowsExecutorResolution,
} from '@rbo/executor';

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

// `rbo doctor` (§33): git, controller port reachability, data dir permissions
// and shell executables run locally; database/compression/TLS/snapshot checks
// arrive with their respective phases (§35).
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNodeEngines(options.nodeVersion),
    await checkGit(),
    checkDataDirWritable(options.dataDir),
    await checkShellExecutables(),
    checkWindowsExecutor(undefined, options.windowsExecutorResolve),
  ];

  if (options.controllerUrl) {
    checks.push(await checkControllerReachable(options.controllerUrl));
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}
