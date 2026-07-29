import { createMockAgentCapability } from '@rbo/testing';
import { describe, expect, it } from 'vitest';
import { updateAgentCapabilities } from '../src/agents/registry.js';
import { listAgents } from '../src/agents/service.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

describe('updateAgentCapabilities', () => {
  it('syncs agents.max_jobs from the capability report so rbo agents matches agent.json', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    db.prepare(
      `INSERT INTO agents
         (id, display_name, hostname, state, priority, max_jobs, capabilities_json, paired_at,
          device_public_key, device_thumbprint, credential_version)
       VALUES ('agt_1', 'main-pc-agent', 'host', 'idle', 0, 1, '{}', datetime('now'),
               'pub', 'thumb', 0)`,
    ).run();

    const report = createMockAgentCapability({
      agent_id: 'agt_1',
      display_name: 'main-pc-agent',
      hostname: 'host',
      execution: {
        max_jobs: 2,
        shells: ['powershell'],
        supports_tty: false,
        supports_process_tree_kill: true,
      },
    });

    updateAgentCapabilities(db, 'agt_1', report);

    const listed = listAgents(db, true);
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'agt_1',
        max_jobs: 2,
      }),
    ]);
    const row = db
      .prepare('SELECT max_jobs, capabilities_json FROM agents WHERE id = ?')
      .get('agt_1') as { max_jobs: number; capabilities_json: string };
    expect(row.max_jobs).toBe(2);
    expect(JSON.parse(row.capabilities_json).execution.max_jobs).toBe(2);
  });
});
