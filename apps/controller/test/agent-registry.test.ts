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
      tools: { git: ['2.45.0'] },
    });

    updateAgentCapabilities(db, 'agt_1', report);

    const listed = listAgents(db, true);
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'agt_1',
        max_jobs: 2,
      }),
    ]);
    expect(listed[0]).not.toHaveProperty('tools');
    const row = db
      .prepare('SELECT max_jobs, capabilities_json FROM agents WHERE id = ?')
      .get('agt_1') as { max_jobs: number; capabilities_json: string };
    expect(row.max_jobs).toBe(2);
    expect(JSON.parse(row.capabilities_json).execution.max_jobs).toBe(2);
    expect(JSON.parse(row.capabilities_json).tools).toEqual({ git: ['2.45.0'] });
  });

  it('reflects connectedAgents in listAgents so offline agents are not reported as idle', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    db.prepare(
      `INSERT INTO agents
         (id, display_name, hostname, state, priority, max_jobs, capabilities_json, paired_at,
          device_public_key, device_thumbprint, credential_version)
       VALUES
         ('agt_idle', 'online-agent', 'host', 'idle', 0, 1, '{}', datetime('now'), 'pub1', 'th1', 0),
         ('agt_offline_in_db', 'offline-agent', 'host', 'idle', 0, 1, '{}', datetime('now'), 'pub2', 'th2', 0),
         ('agt_revoked', 'revoked-agent', 'host', 'revoked', 0, 1, '{}', datetime('now'), 'pub3', 'th3', 0)`,
    ).run();

    // connectedAgents only contains agt_idle
    const connected = new Map<string, unknown>([['agt_idle', {}]]);

    // includeOffline = true (e.g. rbo agents)
    const allListed = listAgents(db, true, connected);
    expect(allListed).toHaveLength(3);
    const idleAgent = allListed.find((a) => a.id === 'agt_idle');
    const offlineAgent = allListed.find((a) => a.id === 'agt_offline_in_db');
    const revokedAgent = allListed.find((a) => a.id === 'agt_revoked');
    expect(idleAgent?.state).toBe('idle');
    expect(offlineAgent?.state).toBe('offline');
    expect(revokedAgent?.state).toBe('revoked');

    // includeOffline = false (e.g. MCP agents_list)
    const onlineOnly = listAgents(db, false, connected);
    expect(onlineOnly.map((a) => a.id)).toEqual(['agt_idle']);
  });

  it('onControllerStartup resets non-offline non-revoked agents to offline', async () => {
    const { RecoveryCoordinator } = await import('../src/recovery/coordinator.js');
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    db.prepare(
      `INSERT INTO agents
         (id, display_name, hostname, state, priority, max_jobs, capabilities_json, paired_at,
          device_public_key, device_thumbprint, credential_version)
       VALUES
         ('agt_1', 'agent-1', 'host', 'idle', 0, 1, '{}', datetime('now'), 'pub1', 'th1', 0),
         ('agt_2', 'agent-2', 'host', 'busy', 0, 1, '{}', datetime('now'), 'pub2', 'th2', 0),
         ('agt_3', 'agent-3', 'host', 'revoked', 0, 1, '{}', datetime('now'), 'pub3', 'th3', 0),
         ('agt_4', 'agent-4', 'host', 'offline', 0, 1, '{}', datetime('now'), 'pub4', 'th4', 0)`,
    ).run();

    const coordinator = new RecoveryCoordinator({
      db,
      connectedAgents: new Map(),
      disconnectGraceSeconds: 60,
      orphanTimeoutSeconds: 300,
      reconcileDeadlineSeconds: 120,
    });
    coordinator.onControllerStartup();

    const states = db.prepare('SELECT id, state FROM agents ORDER BY id').all() as Array<{
      id: string;
      state: string;
    }>;
    expect(states).toEqual([
      { id: 'agt_1', state: 'offline' },
      { id: 'agt_2', state: 'offline' },
      { id: 'agt_3', state: 'revoked' },
      { id: 'agt_4', state: 'offline' },
    ]);
  });
});
