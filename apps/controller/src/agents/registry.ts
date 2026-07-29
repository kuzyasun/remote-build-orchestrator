import type { AgentCapabilityReport } from '@rbo/protocol';
import { RboError } from '@rbo/shared';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';

export function revokeAgent(db: ControllerDatabase, agentId: string): void {
  const info = db
    .prepare("UPDATE agents SET revoked_at = ?, state = 'revoked', disabled_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), agentId);
  if (info.changes === 0) {
    throw RboError.validation(`Unknown agent '${agentId}'`);
  }
}

export function updateAgentCapabilities(
  db: ControllerDatabase,
  agentId: string,
  report: AgentCapabilityReport,
): void {
  // Keep agents.max_jobs in sync with the live capability report (agent.json max_jobs).
  // Pairing inserts a default of 1; without this, `rbo agents` stays stuck at 1 forever.
  db.prepare(
    'UPDATE agents SET capabilities_json = ?, hostname = ?, max_jobs = ?, last_boot_id = ?, last_seen_at = ? WHERE id = ?',
  ).run(
    JSON.stringify(report),
    report.hostname,
    report.execution.max_jobs,
    report.boot_id ?? null,
    nowIso(),
    agentId,
  );
}

/** Last known agent process boot_id, or null when none recorded (pre-v4 / older Agent). */
export function getAgentLastBootId(db: ControllerDatabase, agentId: string): string | null {
  const row = db.prepare('SELECT last_boot_id FROM agents WHERE id = ?').get(agentId) as
    | { last_boot_id: string | null }
    | undefined;
  return row?.last_boot_id ?? null;
}

/** Merge heartbeat cpu_load into stored capabilities for §19.2 scoring. */
export function patchAgentCpuLoad(db: ControllerDatabase, agentId: string, cpuLoad: number): void {
  const row = db.prepare('SELECT capabilities_json FROM agents WHERE id = ?').get(agentId) as
    | { capabilities_json: string }
    | undefined;
  if (!row) {
    return;
  }
  try {
    const caps = JSON.parse(row.capabilities_json) as AgentCapabilityReport;
    caps.resources.cpu_load = Math.min(1, Math.max(0, cpuLoad));
    db.prepare('UPDATE agents SET capabilities_json = ?, last_seen_at = ? WHERE id = ?').run(
      JSON.stringify(caps),
      nowIso(),
      agentId,
    );
  } catch {
    // skip invalid stored capabilities
  }
}

export function setAgentState(db: ControllerDatabase, agentId: string, state: string): void {
  db.prepare('UPDATE agents SET state = ?, last_seen_at = ? WHERE id = ?').run(
    state,
    nowIso(),
    agentId,
  );
}
