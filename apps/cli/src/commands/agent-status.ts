import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_CONFIG_FILENAME } from '@rbo/agent/config';
import { agentRuntimeStatusPath } from '@rbo/shared';
import { findLiveRolePids } from '../../scripts/stop-running-rbo.mjs';
import { agentLogPath } from './daemon.js';

const RUNTIME_CONNECTIONS = new Set([
  'connecting',
  'authenticated',
  'pairing_pending',
  'rejected',
  'incompatible_protocol',
  'disconnected',
  'error',
  'stopped',
]);

export interface AgentStatusReport {
  stateDir: string;
  pids: number[];
  configPresent: boolean;
  configError?: string;
  controllerUrl: string | null;
  fingerprint: string | null;
  displayName: string | null;
  binding: 'none' | 'credential' | 'device-key' | 'unreadable';
  agentId: string | null;
  connection: string;
  last?: string;
  logPath: string;
}

interface RuntimeSnapshot {
  pid: number;
  updatedAt: string;
  connection: string;
  agentId?: string;
  detail?: string;
}

interface LogSnapshot {
  connection: string;
  agentId?: string;
  detail?: string;
}

export interface CollectAgentStatusOptions {
  stateDir: string;
  findPids?: (role: 'agent', options: { stateDir: string }) => Promise<number[]>;
}

function line(label: string, value: string): string {
  return `${`${label}:`.padEnd(14)}${value}`;
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    const newline = text.indexOf('\n');
    return start > 0 && newline >= 0 ? text.slice(newline + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function connectionFromLogTail(text: string): LogSnapshot | null {
  const lines = text.split(/\r?\n/).filter((entry) => entry.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: { message?: string; context?: Record<string, unknown> };
    try {
      parsed = JSON.parse(lines[index] ?? '') as typeof parsed;
    } catch {
      continue;
    }
    const message = parsed.message;
    const context = parsed.context ?? {};
    if (message === 'connection failed, retrying') {
      const raw = typeof context.error === 'string' ? context.error : 'connection failed';
      return { connection: 'error', detail: raw.replace(/^Error:\s*/, '') };
    }
    if (message === 'agent authenticated') {
      const agentId = typeof context.agentId === 'string' ? context.agentId : undefined;
      return { connection: 'authenticated', agentId };
    }
    if (message === 'pairing request pending operator approval') {
      return { connection: 'pairing_pending' };
    }
    if (message === 'connection did not authenticate') {
      const status = typeof context.status === 'string' ? context.status : 'rejected';
      return {
        connection: status === 'incompatible_protocol' ? status : 'rejected',
        detail: status,
      };
    }
    if (message === 'agent stopped') {
      return { connection: 'stopped' };
    }
    if (message === 'agent starting') {
      return { connection: 'connecting' };
    }
  }
  return null;
}

function readRuntimeSnapshot(stateDir: string): RuntimeSnapshot | null {
  const path = agentRuntimeStatusPath(stateDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      pid?: unknown;
      updated_at?: unknown;
      connection?: unknown;
      agent_id?: unknown;
      detail?: unknown;
    };
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.updated_at !== 'string' ||
      typeof parsed.connection !== 'string' ||
      !RUNTIME_CONNECTIONS.has(parsed.connection)
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      updatedAt: parsed.updated_at,
      connection: parsed.connection,
      ...(typeof parsed.agent_id === 'string' && parsed.agent_id.length > 0
        ? { agentId: parsed.agent_id }
        : {}),
      ...(typeof parsed.detail === 'string' && parsed.detail.length > 0
        ? { detail: parsed.detail }
        : {}),
    };
  } catch {
    return null;
  }
}

function describeConnection(connection: string, detail?: string): string {
  switch (connection) {
    case 'authenticated':
      return 'connected';
    case 'pairing_pending':
      return 'connected (pairing pending approval)';
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'not connected (reconnecting)';
    case 'rejected':
      return 'not connected (rejected by controller)';
    case 'incompatible_protocol':
      return 'not connected (incompatible protocol)';
    case 'error':
      return detail ? `not connected (${detail})` : 'not connected (connection error)';
    case 'stopped':
      return 'not connected';
    default:
      return 'not connected';
  }
}

function readBinding(stateDir: string): {
  binding: AgentStatusReport['binding'];
  agentId: string | null;
} {
  const path = join(stateDir, 'agent-state.json');
  if (!existsSync(path)) {
    return { binding: 'none', agentId: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      credential?: unknown;
      agentId?: unknown;
      devicePublicKeyPem?: unknown;
    };
    const agentId =
      typeof parsed.agentId === 'string' && parsed.agentId.length > 0 ? parsed.agentId : null;
    if (typeof parsed.credential === 'string' && parsed.credential.length > 0) {
      return { binding: 'credential', agentId };
    }
    if (typeof parsed.devicePublicKeyPem === 'string' && parsed.devicePublicKeyPem.length > 0) {
      return { binding: 'device-key', agentId };
    }
    return { binding: 'none', agentId };
  } catch {
    return { binding: 'unreadable', agentId: null };
  }
}

function readConfig(stateDir: string): {
  present: boolean;
  error?: string;
  controllerUrl: string | null;
  fingerprint: string | null;
  displayName: string | null;
} {
  const path = join(stateDir, AGENT_CONFIG_FILENAME);
  if (!existsSync(path)) {
    return { present: false, controllerUrl: null, fingerprint: null, displayName: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      controller_url?: unknown;
      controller_fingerprint?: unknown;
      display_name?: unknown;
    };
    const controllerUrl =
      typeof parsed.controller_url === 'string' && parsed.controller_url.trim().length > 0
        ? parsed.controller_url.trim()
        : null;
    const fingerprint =
      typeof parsed.controller_fingerprint === 'string' &&
      parsed.controller_fingerprint.trim().length > 0
        ? parsed.controller_fingerprint.trim()
        : null;
    const displayName =
      typeof parsed.display_name === 'string' && parsed.display_name.trim().length > 0
        ? parsed.display_name.trim()
        : null;
    return { present: true, controllerUrl, fingerprint, displayName };
  } catch (error) {
    return {
      present: true,
      error: error instanceof Error ? error.message : String(error),
      controllerUrl: null,
      fingerprint: null,
      displayName: null,
    };
  }
}

export async function collectAgentStatus(
  options: CollectAgentStatusOptions,
): Promise<AgentStatusReport> {
  const findPids = options.findPids ?? findLiveRolePids;
  const pids = await findPids('agent', { stateDir: options.stateDir });
  const config = readConfig(options.stateDir);
  const binding = readBinding(options.stateDir);
  const runtime = readRuntimeSnapshot(options.stateDir);
  let logSnapshot: LogSnapshot | null = null;
  const logPath = agentLogPath(options.stateDir);
  if (existsSync(logPath)) {
    try {
      logSnapshot = connectionFromLogTail(readTail(logPath, 256 * 1024));
    } catch {
      logSnapshot = null;
    }
  }

  const runtimeIsLive = runtime !== null && pids.includes(runtime.pid);
  let connection: string;
  let last: string | undefined;

  if (pids.length === 0) {
    connection = 'not connected';
    if (runtime && runtime.connection !== 'stopped') {
      last = `${describeConnection(runtime.connection, runtime.detail)} at ${runtime.updatedAt}`;
    } else if (logSnapshot && logSnapshot.connection !== 'stopped') {
      last = describeConnection(logSnapshot.connection, logSnapshot.detail);
    }
  } else if (runtimeIsLive && runtime) {
    connection = describeConnection(runtime.connection, runtime.detail);
  } else if (logSnapshot) {
    connection = describeConnection(logSnapshot.connection, logSnapshot.detail);
  } else {
    connection = 'not reported yet';
  }

  return {
    stateDir: options.stateDir,
    pids,
    configPresent: config.present,
    configError: config.error,
    controllerUrl: config.controllerUrl,
    fingerprint: config.fingerprint,
    displayName: config.displayName,
    binding: binding.binding,
    agentId: binding.agentId ?? runtime?.agentId ?? logSnapshot?.agentId ?? null,
    connection,
    last,
    logPath,
  };
}

function bindingText(report: AgentStatusReport): string {
  if (report.binding === 'credential') {
    return report.agentId ? `credential stored (${report.agentId})` : 'credential stored';
  }
  if (report.binding === 'device-key') {
    return 'none (device key present, not paired)';
  }
  if (report.binding === 'unreadable') {
    return 'unreadable';
  }
  return 'none';
}

export function formatAgentStatus(report: AgentStatusReport): string {
  const lines = [
    line(
      'process',
      report.pids.length === 0 ? 'stopped' : `running (pid ${report.pids.join(', ')})`,
    ),
    line('connection', report.connection),
  ];
  if (report.last) {
    lines.push(line('last', report.last));
  }
  lines.push(line('binding', bindingText(report)));
  lines.push(line('controller', report.controllerUrl ?? 'not configured'));
  if (report.fingerprint) {
    lines.push(line('fingerprint', report.fingerprint));
  }
  if (report.displayName) {
    lines.push(line('name', report.displayName));
  }
  if (!report.configPresent) {
    lines.push(line('config', 'not initialized — run `rbo agent init`'));
  } else if (report.configError) {
    lines.push(line('config', `unreadable (${report.configError})`));
  }
  lines.push(line('state dir', report.stateDir));
  lines.push(line('log', report.logPath));
  return lines.join('\n');
}

export async function runAgentStatus(options: CollectAgentStatusOptions): Promise<string> {
  return formatAgentStatus(await collectAgentStatus(options));
}
