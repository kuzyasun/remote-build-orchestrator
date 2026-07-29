import type { AgentCapabilityReport } from '@rbo/protocol';
import type { ControllerDatabase } from '../storage/database.js';

export interface AgentSummary {
  id: string;
  name: string;
  state: string;
  os: string | null;
  arch: string | null;
  priority: number;
  running_jobs: number;
  max_jobs: number;
  tools: Record<string, string[]>;
}

interface AgentRow {
  id: string;
  display_name: string;
  hostname: string | null;
  state: string;
  priority: number;
  max_jobs: number;
  capabilities_json: string;
}

export function listAgents(db: ControllerDatabase, includeOffline: boolean): AgentSummary[] {
  const rows = db
    .prepare(
      includeOffline
        ? 'SELECT * FROM agents WHERE disabled_at IS NULL ORDER BY priority DESC, id'
        : "SELECT * FROM agents WHERE disabled_at IS NULL AND state <> 'offline' ORDER BY priority DESC, id",
    )
    .all() as AgentRow[];

  return rows.map((row) => {
    let capabilities: Partial<AgentCapabilityReport> = {};
    try {
      capabilities = JSON.parse(row.capabilities_json) as Partial<AgentCapabilityReport>;
    } catch {
      // Capability JSON is agent-supplied; a corrupt row must not break listing.
    }
    const runningJobs = db
      .prepare(
        "SELECT COUNT(*) AS n FROM job_attempts WHERE agent_id = ? AND state NOT IN ('completed')",
      )
      .get(row.id) as { n: number };

    return {
      id: row.id,
      name: row.display_name,
      state: row.state,
      os: capabilities.os?.family ?? null,
      arch: capabilities.os?.arch ?? null,
      priority: row.priority,
      running_jobs: runningJobs.n,
      max_jobs: row.max_jobs,
      tools: capabilities.tools ?? {},
    };
  });
}
