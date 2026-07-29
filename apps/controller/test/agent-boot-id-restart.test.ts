import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentLastBootId, updateAgentCapabilities } from '../src/agents/registry.js';
import { createJob, getAttempt, getJob, transitionJobState } from '../src/jobs/lifecycle.js';
import { RecoveryCoordinator } from '../src/recovery/coordinator.js';
import { getActiveJobsForAgents } from '../src/scheduler/index.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function insertAgent(db: ControllerDatabase, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
     VALUES (?, ?, ?, 'offline', '{}', ?)`,
  ).run(agentId, agentId, 'localhost', nowIso());
}

/** Seed a job + a non-terminal attempt pinned to agentId in the given state. */
function seedRunningAttempt(db: ControllerDatabase, agentId: string, state: string): string {
  const job = createJob(db, {
    clientId: 'client',
    clientRequestId: `req_${agentId}_${state}_${Math.random().toString(36).slice(2, 6)}`,
    initialState: 'running',
    request: {
      client_request_id: `req_${agentId}_${state}`,
      source: { project_root: '/tmp', cwd: '.' },
      execution: { script: 'echo hi' },
      queue_policy: 'wait',
      risk_level: 'normal',
    },
  });
  transitionJobState(db, job.id, 'running');
  const attemptId = `att_${job.id}`;
  db.prepare(
    `INSERT INTO job_attempts (
       id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state, log_acked_sequence
     ) VALUES (?, ?, 1, ?, ?, 1, ?, ?, 0)`,
  ).run(
    attemptId,
    job.id,
    agentId,
    `lease_${job.id}`,
    new Date(Date.now() + 600_000).toISOString(),
    state,
  );
  return attemptId;
}

function makeCoordinator(db: ControllerDatabase): RecoveryCoordinator {
  const connectedAgents = new Map<string, ConnectedAgent>();
  return new RecoveryCoordinator({
    db,
    connectedAgents,
    disconnectGraceSeconds: 5,
    orphanTimeoutSeconds: 10,
    reconcileDeadlineSeconds: 8,
  });
}

describe('Agent boot_id restart — sweep leaked attempts on process restart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps all leaked attempts to lost when the agent reconnects with a new boot_id', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    // Two leaked attempts on the agent (e.g. the agent process was killed mid-execution).
    const att1 = seedRunningAttempt(db, 'agt_1', 'running');
    const att2 = seedRunningAttempt(db, 'agt_1', 'collecting_artifacts');
    const job1 = getAttempt(db, att1)?.job_id as string;
    const job2 = getAttempt(db, att2)?.job_id as string;

    // Record that the agent previously reported boot_id "boot_old".
    db.prepare('UPDATE agents SET last_boot_id = ? WHERE id = ?').run('boot_old', 'agt_1');

    const coordinator = makeCoordinator(db);
    // Agent restarts and reconnects with a new boot_id.
    coordinator.onAgentConnect('agt_1', 'boot_new');

    // Both leaked attempts fail as lost; their jobs fail as agent_disconnected.
    expect(getAttempt(db, att1)?.state).toBe('completed');
    expect(getAttempt(db, att1)?.outcome).toBe('lost');
    expect(getAttempt(db, att2)?.state).toBe('completed');
    expect(getAttempt(db, att2)?.outcome).toBe('lost');
    expect(getJob(db, job1)?.outcome).toBe('lost');
    expect(getJob(db, job1)?.failure_category).toBe('agent_disconnected');
    expect(getJob(db, job2)?.outcome).toBe('lost');

    // The agent no longer carries any active attempts → capacity is free again.
    expect(getActiveJobsForAgents(db).get('agt_1') ?? 0).toBe(0);
    db.close();
  });

  it('does NOT touch attempts when the agent reconnects with the same boot_id (network reconnect)', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');
    db.prepare('UPDATE agents SET last_boot_id = ? WHERE id = ?').run('boot_same', 'agt_1');

    const att = seedRunningAttempt(db, 'agt_1', 'running');
    const jobId = getAttempt(db, att)?.job_id as string;

    const coordinator = makeCoordinator(db);
    // Network blip → same process → same boot_id. Attempts must survive.
    coordinator.onAgentConnect('agt_1', 'boot_same');

    expect(getAttempt(db, att)?.state).toBe('running');
    expect(getJob(db, jobId)?.state).toBe('running');
    db.close();
  });

  it('does NOT sweep when boot_id is absent (older agent — back-compat)', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');
    // No last_boot_id recorded (pre-v4 or older agent never sent one).

    const att = seedRunningAttempt(db, 'agt_1', 'running');

    const coordinator = makeCoordinator(db);
    // Older agent sends capabilities without boot_id → undefined.
    coordinator.onAgentConnect('agt_1', undefined);

    expect(getAttempt(db, att)?.state).toBe('running');
    // updateAgentCapabilities stores null boot_id for such agents.
    db.close();
  });

  it('updateAgentCapabilities persists the reported boot_id as the new last_boot_id', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const caps = {
      agent_id: 'agt_1',
      display_name: 'agt_1',
      hostname: 'localhost',
      os: { family: 'linux' as const, version: '10', arch: 'x64' },
      resources: {
        cpu_logical: 4,
        memory_total_mb: 8192,
        memory_free_mb: 4096,
        disk_free_mb: 10000,
      },
      execution: {
        max_jobs: 3,
        shells: ['bash'],
        supports_tty: false,
        supports_process_tree_kill: true,
      },
      tools: {},
      toolchain_profiles: [],
      labels: {},
      secret_refs: [],
      boot_id: 'boot_persisted',
    };
    updateAgentCapabilities(db, 'agt_1', caps);
    expect(getAgentLastBootId(db, 'agt_1')).toBe('boot_persisted');
    db.close();
  });

  it('sweeps nothing when there are no active attempts (restart of an idle agent)', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');
    db.prepare('UPDATE agents SET last_boot_id = ? WHERE id = ?').run('boot_old', 'agt_1');

    const coordinator = makeCoordinator(db);
    // No attempts exist; restart must be a harmless no-op (no throw, no change).
    coordinator.onAgentConnect('agt_1', 'boot_new');
    expect(getActiveJobsForAgents(db).get('agt_1') ?? 0).toBe(0);
    db.close();
  });
});
