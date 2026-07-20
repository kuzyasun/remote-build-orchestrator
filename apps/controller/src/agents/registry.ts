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
  db.prepare(
    'UPDATE agents SET capabilities_json = ?, hostname = ?, last_seen_at = ? WHERE id = ?',
  ).run(JSON.stringify(report), report.hostname, nowIso(), agentId);
}

export function setAgentState(db: ControllerDatabase, agentId: string, state: string): void {
  db.prepare('UPDATE agents SET state = ?, last_seen_at = ? WHERE id = ?').run(
    state,
    nowIso(),
    agentId,
  );
}
