import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentLastBootId, updateAgentCapabilities } from '../src/agents/registry.js';
import { expireStaleLeases } from '../src/execution/remote-execution.js';
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

  it.each([true, false])(
    'preserves the exited process result after Agent restart (reports=%s)',
    (reports) => {
      const db = openDatabase(':memory:');
      migrateToLatest(db);
      insertAgent(db, 'agt_1');
      db.prepare("UPDATE agents SET last_boot_id = 'boot_old' WHERE id = 'agt_1'").run();
      const attemptId = seedRunningAttempt(db, 'agt_1', 'collecting_artifacts');
      const attempt = getAttempt(db, attemptId);
      if (!attempt) throw new Error('Missing fixture attempt');
      db.prepare("UPDATE job_attempts SET outcome = 'succeeded' WHERE id = ?").run(attemptId);
      db.prepare("UPDATE jobs SET state = 'collecting_artifacts', exit_code = 0 WHERE id = ?").run(
        attempt.job_id,
      );
      const coordinator = makeCoordinator(db);
      try {
        coordinator.onAgentConnect('agt_1', 'boot_new');
        expect(getAttempt(db, attemptId)).toMatchObject({
          state: 'collecting_artifacts',
          outcome: 'succeeded',
        });
        if (reports) {
          expect(
            coordinator.onRecoveryReport('agt_1', {
              attempt_id: attemptId,
              lease_id: attempt.lease_id,
              lease_epoch: attempt.lease_epoch,
              status: 'completed_awaiting_upload',
              process_identity: 'unavailable',
              last_sent_sequence: 0,
              last_acked_sequence: 0,
              artifact_upload_pending: true,
            }).action,
          ).toBe('adopt');
        }
        vi.advanceTimersByTime(8_000);
        if (reports) {
          expect(getAttempt(db, attemptId)).toMatchObject({
            state: 'collecting_artifacts',
            process_identity: null,
          });
        } else {
          expect(getAttempt(db, attemptId)).toMatchObject({
            state: 'completed',
            outcome: 'succeeded',
          });
          expect(getJob(db, attempt.job_id)).toMatchObject({
            state: 'completed',
            outcome: 'succeeded',
            exit_code: 0,
            failure_category: null,
          });
        }
      } finally {
        coordinator.dispose();
        db.close();
      }
    },
  );

  it('requires a recorded process exit to adopt an artifact-only recovery report', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');
    const attemptId = seedRunningAttempt(db, 'agt_1', 'running');
    const attempt = getAttempt(db, attemptId);
    if (!attempt) throw new Error('Missing fixture attempt');
    const coordinator = makeCoordinator(db);
    try {
      expect(
        coordinator.onRecoveryReport('agt_1', {
          attempt_id: attemptId,
          lease_id: attempt.lease_id,
          lease_epoch: attempt.lease_epoch,
          status: 'completed_awaiting_upload',
          process_identity: 'unavailable',
          last_sent_sequence: 0,
          last_acked_sequence: 0,
          artifact_upload_pending: true,
        }),
      ).toMatchObject({ action: 'terminate_stale', reason: 'process_exit_not_recorded' });
    } finally {
      coordinator.dispose();
      db.close();
    }
  });

  it.each(['completed', 'still running', 'missing report', 'expired lease'] as const)(
    'handles a declared pending exit after Agent restart when %s',
    (scenario) => {
      const db = openDatabase(':memory:');
      migrateToLatest(db);
      insertAgent(db, 'agt_1');
      db.prepare("UPDATE agents SET last_boot_id = 'boot_old' WHERE id = 'agt_1'").run();
      const attemptId = seedRunningAttempt(db, 'agt_1', 'running');
      const attempt = getAttempt(db, attemptId);
      if (!attempt) throw new Error('Missing fixture attempt');
      if (scenario === 'expired lease') {
        db.prepare('UPDATE job_attempts SET lease_deadline = ? WHERE id = ?').run(
          new Date(Date.now() - 1).toISOString(),
          attemptId,
        );
      }
      const coordinator = makeCoordinator(db);
      try {
        coordinator.onAgentConnect('agt_1', 'boot_new', [attemptId]);
        if (scenario === 'missing report') {
          expect(getAttempt(db, attemptId)?.state).toBe('running');
          vi.advanceTimersByTime(8_000);
          expect(getAttempt(db, attemptId)?.outcome).toBe('lost');
          return;
        }
        const artifactPending = scenario !== 'still running';
        const decision = coordinator.onRecoveryReport('agt_1', {
          attempt_id: attemptId,
          lease_id: attempt.lease_id,
          lease_epoch: attempt.lease_epoch,
          status: artifactPending ? 'completed_awaiting_upload' : 'running',
          process_identity: 'unavailable',
          last_sent_sequence: 0,
          last_acked_sequence: 0,
          artifact_upload_pending: artifactPending,
          ...(artifactPending ? { process_exit: { exit_code: 0, outcome: 'succeeded' } } : {}),
        });
        if (scenario === 'completed') {
          expect(decision.action).toBe('adopt');
          expect(getAttempt(db, attemptId)).toMatchObject({
            state: 'collecting_artifacts',
            outcome: 'succeeded',
          });
        } else {
          expect(decision.action).toBe('terminate_stale');
          expect(getAttempt(db, attemptId)?.state).toBe('completed');
        }
      } finally {
        coordinator.dispose();
        db.close();
      }
    },
  );

  it.each(['collecting_artifacts', 'cleaning'])(
    'finishes a %s job with an already completed remote attempt on Controller startup',
    (state) => {
      const db = openDatabase(':memory:');
      migrateToLatest(db);
      insertAgent(db, 'agt_1');
      const attemptId = seedRunningAttempt(db, 'agt_1', 'completed');
      const attempt = getAttempt(db, attemptId);
      if (!attempt) throw new Error('Missing fixture attempt');
      const finishedAt = nowIso();
      db.prepare("UPDATE job_attempts SET outcome = 'failed', finished_at = ? WHERE id = ?").run(
        finishedAt,
        attemptId,
      );
      transitionJobState(db, attempt.job_id, state, {
        exit_code: 7,
        failure_category: 'process_exit',
      });

      const coordinator = makeCoordinator(db);
      try {
        coordinator.onControllerStartup();
        expect(getJob(db, attempt.job_id)).toMatchObject({
          state: 'completed',
          outcome: 'failed',
          finished_at: finishedAt,
          exit_code: 7,
          failure_category: 'process_exit',
        });
      } finally {
        coordinator.dispose();
        db.close();
      }
    },
  );

  it.each(['leasing', 'preparing_source', 'running', 'queued'])(
    'reconciles a completed attempt on startup when the job is %s',
    (state) => {
      const db = openDatabase(':memory:');
      migrateToLatest(db);
      insertAgent(db, 'agt_1');
      const attemptId = seedRunningAttempt(db, 'agt_1', 'completed');
      const attempt = getAttempt(db, attemptId);
      if (!attempt) throw new Error('Missing fixture attempt');
      const outcome = state === 'running' ? 'lost' : 'failed';
      const finishedAt = nowIso();
      db.prepare('UPDATE job_attempts SET outcome = ?, finished_at = ? WHERE id = ?').run(
        outcome,
        finishedAt,
        attemptId,
      );
      transitionJobState(db, attempt.job_id, state);

      const coordinator = makeCoordinator(db);
      try {
        coordinator.onControllerStartup();
        expect(getJob(db, attempt.job_id)).toMatchObject(
          state === 'queued'
            ? { state: 'queued', outcome: null, finished_at: null }
            : {
                state: 'completed',
                outcome,
                finished_at: finishedAt,
                failure_category: 'agent_disconnected',
              },
        );
      } finally {
        coordinator.dispose();
        db.close();
      }
    },
  );

  it('rolls back lease expiry if the job update fails, then finalizes both on retry', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    const coordinator = makeCoordinator(db);
    try {
      insertAgent(db, 'agt_1');
      const attemptId = seedRunningAttempt(db, 'agt_1', 'running');
      const attempt = getAttempt(db, attemptId);
      if (!attempt) throw new Error('Missing fixture attempt');
      db.prepare('UPDATE job_attempts SET lease_deadline = ? WHERE id = ?').run(
        nowIso(),
        attemptId,
      );
      db.exec(`CREATE TRIGGER fail_job_completion BEFORE UPDATE ON jobs WHEN NEW.state = 'completed'
               BEGIN SELECT RAISE(ABORT, 'job completion failed'); END;`);

      expect(() => expireStaleLeases(db)).toThrow('job completion failed');
      expect(getAttempt(db, attemptId)).toMatchObject({ state: 'running', outcome: null });
      expect(getJob(db, attempt.job_id)).toMatchObject({ state: 'running', outcome: null });

      db.exec('DROP TRIGGER fail_job_completion');
      expireStaleLeases(db);
      expect(getAttempt(db, attemptId)).toMatchObject({ state: 'completed', outcome: 'failed' });
      expect(getJob(db, attempt.job_id)).toMatchObject({
        state: 'completed',
        outcome: 'failed',
        failure_category: 'agent_disconnected',
      });
    } finally {
      coordinator.dispose();
      db.close();
    }
  });

  it('keeps artifact recovery eligible after Controller startup with an expired old lease', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');
    const attemptId = seedRunningAttempt(db, 'agt_1', 'collecting_artifacts');
    const attempt = getAttempt(db, attemptId);
    if (!attempt) throw new Error('Missing fixture attempt');
    db.prepare(
      "UPDATE job_attempts SET outcome = 'succeeded', lease_deadline = ? WHERE id = ?",
    ).run(new Date(Date.now() - 1).toISOString(), attemptId);
    const coordinator = makeCoordinator(db);
    try {
      coordinator.onControllerStartup();
      vi.advanceTimersByTime(4_000);
      expireStaleLeases(db);
      expect(
        coordinator.onRecoveryReport('agt_1', {
          attempt_id: attemptId,
          lease_id: attempt.lease_id,
          lease_epoch: attempt.lease_epoch,
          status: 'completed_awaiting_upload',
          process_identity: 'unavailable',
          last_sent_sequence: 0,
          last_acked_sequence: 0,
          artifact_upload_pending: true,
        }).action,
      ).toBe('adopt');
    } finally {
      coordinator.dispose();
      db.close();
    }
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
