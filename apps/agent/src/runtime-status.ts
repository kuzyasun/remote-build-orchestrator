import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentRuntimeStatusPath } from '@rbo/shared';

export const AGENT_RUNTIME_CONNECTIONS = [
  'connecting',
  'authenticated',
  'pairing_pending',
  'rejected',
  'incompatible_protocol',
  'disconnected',
  'error',
  'stopped',
] as const;

export type AgentRuntimeConnection = (typeof AGENT_RUNTIME_CONNECTIONS)[number];

export interface AgentRuntimeStatus {
  pid: number;
  updated_at: string;
  connection: AgentRuntimeConnection;
  agent_id?: string;
  controller_url?: string;
  detail?: string;
}

function sanitizeDetail(detail: string): string {
  const noPem = detail.replace(/-----BEGIN[\s\S]*?-----END[^\n-]*-----/g, '[redacted]');
  const noJwt = noPem.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '[redacted]',
  );
  const oneLine = noJwt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

export function writeAgentRuntimeStatus(
  stateDir: string,
  status: {
    connection: AgentRuntimeConnection;
    agent_id?: string;
    controller_url?: string;
    detail?: string;
    pid?: number;
  },
): void {
  const path = agentRuntimeStatusPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const body: AgentRuntimeStatus = {
    pid: status.pid ?? process.pid,
    updated_at: new Date().toISOString(),
    connection: status.connection,
    ...(status.agent_id ? { agent_id: status.agent_id } : {}),
    ...(status.controller_url ? { controller_url: status.controller_url } : {}),
    ...(status.detail ? { detail: sanitizeDetail(status.detail) } : {}),
  };
  writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
}
