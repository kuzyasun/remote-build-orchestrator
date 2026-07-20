import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAttemptLogs, readLogsFromCursor } from '@rbo/executor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  type RemoteExecutionOptions,
  handleRemoteJobExit,
  handleRemoteLogChunk,
} from '../src/execution/remote-execution.js';
import { attemptLogDir } from '../src/execution/runner.js';
import {
  ATTEMPT_OUTCOME_LOST,
  ATTEMPT_STATE_ORPHANED,
  createJob,
  getAttempt,
  getJob,
  transitionJobState,
} from '../src/jobs/lifecycle.js';
import { RecoveryCoordinator } from '../src/recovery/coordinator.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function mockSocket(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

function insertAgent(db: ReturnType<typeof openDatabase>, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
     VALUES (?, ?, ?, 'offline', '{}', ?)`,
  ).run(agentId, agentId, 'localhost', nowIso());
}

describe('reconnect reconcile (Phase 6 recovery)', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setup(opts?: {
    risk_level?: 'safe' | 'normal' | 'destructive' | 'hardware';
    withProcess?: boolean;
    attemptState?: string;
  }) {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-reconnect-'));
    const db = openDatabase(join(dataDir, 'controller.db'));
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const identity = {
      controllerId: 'ctl',
      fingerprint: 'sha256:abc',
      tlsCertPem: '',
      tlsKeyPem: '',
      signingPublicKeyPem: '',
      signingPrivateKeyPem: '',
    };

    const risk = opts?.risk_level ?? 'safe';
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: `req_reconnect_${risk}`,
      initialState: 'queued',
      request: {
        client_request_id: `req_reconnect_${risk}`,
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
        risk_level: risk,
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = 'att_rec_1';
    const leaseId = 'lease_rec_1';
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    const state = opts?.attemptState ?? 'running';
    const processIdentity = opts?.withProcess === false ? null : 'pid:4242';

    db.prepare(
      `INSERT INTO job_attempts (
         id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state,
         process_identity, log_acked_sequence
       ) VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?, 0)`,
    ).run(attemptId, job.id, 'agt_1', leaseId, futureDeadline, state, processIdentity);

    const socket = mockSocket();
    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        'agt_1',
        {
          agentId: 'agt_1',
          socket,
          protocolVersion: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
    ]);

    const remoteOpts: RemoteExecutionOptions = {
      db,
      identity,
      dataDir,
      connectedAgents,
      serverPort: 0,
    };

    const coordinator = new RecoveryCoordinator({
      db,
      connectedAgents,
      disconnectGraceSeconds: 5,
      orphanTimeoutSeconds: 10,
      reconcileDeadlineSeconds: 8,
    });

    return {
      db,
      remoteOpts,
      socket,
      attemptId,
      leaseId,
      processIdentity,
      coordinator,
      jobId: job.id,
    };
  }

  it('disconnect during safe job → grace → reconnect same tuple → adopt → ordered non-duplicated logs', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator } = await setup({
      risk_level: 'safe',
      withProcess: true,
    });

    // Seed one acked chunk before disconnect
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'hello',
    });
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(1);

    // Disconnect: must NOT terminal-fail immediately
    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.outcome).toBeNull();

    // Grace elapses → orphaned
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAttempt(db, attemptId)?.state).toBe(ATTEMPT_STATE_ORPHANED);
    expect(getAttempt(db, attemptId)?.orphaned_at).toBeTruthy();

    // Reconnect + recovery_report with matching tuple → adopt
    const socket2 = mockSocket();
    remoteOpts.connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 2,
      last_acked_sequence: 1,
      artifact_upload_pending: false,
    });

    expect(decision).toMatchObject({
      action: 'adopt',
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      resume_from_sequence: 1,
    });
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.orphaned_at).toBeNull();
    expect(socket2.sent.some((m) => m.type === 'reconcile_decision')).toBe(true);

    // Replay sequence 2 after adopt — ordered, no duplicate of seq 1
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'hello',
    });
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 2,
      bytes: ' world',
    });

    const logDir = attemptLogDir(dataDir, attemptId);
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('hello world');
    const logs = await ensureAttemptLogs(logDir);
    const chunk = await readLogsFromCursor(logs, 0, 10_000, ['stdout']);
    expect(chunk.data).toBe('hello world');

    coordinator.dispose();
    db.close();
  });

  it('replacement / newer epoch → terminate_stale; stale log_chunk rejected', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator, jobId } = await setup(
      {
        withProcess: true,
      },
    );

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAttempt(db, attemptId)?.state).toBe(ATTEMPT_STATE_ORPHANED);

    // Controller advances epoch (replacement fencing) while orphaned
    db.prepare('UPDATE job_attempts SET lease_epoch = 2 WHERE id = ?').run(attemptId);

    const socket2 = mockSocket();
    remoteOpts.connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1, // stale epoch
      status: 'running',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 5,
      last_acked_sequence: 0,
      artifact_upload_pending: false,
    });

    expect(decision).toMatchObject({
      action: 'terminate_stale',
      attempt_id: attemptId,
      reason: 'newer_epoch',
    });
    expect(socket2.sent.some((m) => m.type === 'reconcile_decision')).toBe(true);
    const payload = socket2.sent.find((m) => m.type === 'reconcile_decision')?.payload as Record<
      string,
      unknown
    >;
    expect(payload.action).toBe('terminate_stale');

    // terminate_stale must terminalize — cannot sit forever in orphaned
    const attempt = getAttempt(db, attemptId);
    expect(attempt?.state).toBe('completed');
    expect(attempt?.outcome).toBe('failed');
    expect(attempt?.orphaned_at).toBeNull();
    expect(getJob(db, jobId)?.failure_category).toBe('lease_expired');

    // Stale log_chunk with old epoch must not append
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'stale',
    });
    const logDir = attemptLogDir(dataDir, attemptId);
    await expect(readFile(join(logDir, 'stdout.log'), 'utf8')).rejects.toThrow();

    coordinator.dispose();
    db.close();
  });

  it('reconnect during grace (before orphan) still adopts', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator } = await setup({
      withProcess: true,
    });

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    expect(getAttempt(db, attemptId)?.state).toBe('running');

    // Reconnect before grace elapses
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.orphaned_at).toBeNull();

    const socket2 = mockSocket();
    remoteOpts.connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 0,
      last_acked_sequence: 0,
      artifact_upload_pending: false,
    });

    expect(decision.action).toBe('adopt');
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.orphaned_at).toBeNull();

    // Grace timer must not orphan after adopt
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getAttempt(db, attemptId)?.state).toBe('running');

    coordinator.dispose();
    db.close();
  });

  it('terminate_stale with process_identity mismatch marks attempt failed/agent_lost', async () => {
    const { db, remoteOpts, attemptId, leaseId, coordinator, jobId } = await setup({
      withProcess: true,
    });

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAttempt(db, attemptId)?.state).toBe(ATTEMPT_STATE_ORPHANED);

    const socket2 = mockSocket();
    remoteOpts.connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: 'pid:9999',
      last_sent_sequence: 0,
      last_acked_sequence: 0,
      artifact_upload_pending: false,
    });

    expect(decision).toMatchObject({
      action: 'terminate_stale',
      reason: 'process_identity_mismatch',
    });
    const attempt = getAttempt(db, attemptId);
    expect(attempt?.state).toBe('completed');
    expect(attempt?.outcome).toBe('failed');
    expect(attempt?.orphaned_at).toBeNull();
    expect(getJob(db, jobId)?.failure_category).toBe('agent_lost');
    expect(getJob(db, jobId)?.state).toBe('completed');

    coordinator.dispose();
    db.close();
  });

  it('completion during disconnect: orphaned accepts job_exit; adopt completed_awaiting_upload', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator, jobId } = await setup(
      {
        withProcess: true,
      },
    );

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAttempt(db, attemptId)?.state).toBe(ATTEMPT_STATE_ORPHANED);

    // job_exit while still orphaned (process finished during grace/orphan)
    handleRemoteJobExit(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      exit_code: 0,
      outcome: 'succeeded',
    });

    expect(getAttempt(db, attemptId)?.state).toBe('collecting_artifacts');
    expect(getAttempt(db, attemptId)?.outcome).toBe('succeeded');
    expect(getAttempt(db, attemptId)?.orphaned_at).toBeNull();
    expect(getJob(db, jobId)?.state).toBe('collecting_artifacts');
    expect(getJob(db, jobId)?.exit_code).toBe(0);

    coordinator.dispose();
    db.close();
  });

  it('adopt completed_awaiting_upload then job_exit reaches collecting_artifacts', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator, jobId } = await setup(
      {
        withProcess: true,
      },
    );

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);

    const socket2 = mockSocket();
    remoteOpts.connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'completed_awaiting_upload',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 3,
      last_acked_sequence: 1,
      artifact_upload_pending: true,
    });

    expect(decision.action).toBe('adopt');
    expect(getAttempt(db, attemptId)?.state).toBe('collecting_artifacts');
    expect(getAttempt(db, attemptId)?.orphaned_at).toBeNull();

    handleRemoteJobExit(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      exit_code: 0,
      outcome: 'succeeded',
    });

    expect(getAttempt(db, attemptId)?.state).toBe('collecting_artifacts');
    expect(getAttempt(db, attemptId)?.outcome).toBe('succeeded');
    expect(getJob(db, jobId)?.exit_code).toBe(0);

    coordinator.dispose();
    db.close();
  });
  it('running without process_identity enters grace (not false pre-start fail)', async () => {
    const { db, remoteOpts, attemptId, coordinator } = await setup({
      withProcess: false,
      attemptState: 'running',
    });

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');

    // Must NOT terminal-fail: job_started race left process_identity null
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.outcome).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAttempt(db, attemptId)?.state).toBe(ATTEMPT_STATE_ORPHANED);

    coordinator.dispose();
    db.close();
  });
  it('disconnect before script start → lost/failed without spawning a new attempt', async () => {
    const { db, remoteOpts, attemptId, coordinator, jobId } = await setup({
      withProcess: false,
      attemptState: 'preparing_source',
    });

    const attemptCountBefore = (
      db.prepare('SELECT COUNT(*) AS c FROM job_attempts WHERE job_id = ?').get(jobId) as {
        c: number;
      }
    ).c;

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');

    const attempt = getAttempt(db, attemptId);
    expect(attempt?.state).toBe('completed');
    expect(['lost', 'failed']).toContain(attempt?.outcome ?? '');
    if (attempt?.outcome === ATTEMPT_OUTCOME_LOST) {
      expect(attempt.outcome).toBe(ATTEMPT_OUTCOME_LOST);
    } else {
      expect(getJob(db, jobId)?.failure_category).toBe('agent_disconnected');
    }

    const attemptCountAfter = (
      db.prepare('SELECT COUNT(*) AS c FROM job_attempts WHERE job_id = ?').get(jobId) as {
        c: number;
      }
    ).c;
    expect(attemptCountAfter).toBe(attemptCountBefore);

    // Grace timer must not resurrect / re-orphan
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAttempt(db, attemptId)?.state).toBe('completed');

    coordinator.dispose();
    db.close();
  });

  it('orphan timeout without recovery_report → outcome lost', async () => {
    const { db, remoteOpts, attemptId, coordinator } = await setup({ withProcess: true });

    connectedAgentsDelete(remoteOpts, 'agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAttempt(db, attemptId)?.state).toBe(ATTEMPT_STATE_ORPHANED);

    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = getAttempt(db, attemptId);
    expect(attempt?.state).toBe('completed');
    expect(attempt?.outcome).toBe(ATTEMPT_OUTCOME_LOST);

    coordinator.dispose();
    db.close();
  });

  it('controller startup arms reconcile deadline → lost when no recovery_report', async () => {
    const { db, attemptId, coordinator } = await setup({ withProcess: true });

    coordinator.onControllerStartup();
    expect(getAttempt(db, attemptId)?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(8_000);
    const attempt = getAttempt(db, attemptId);
    expect(attempt?.state).toBe('completed');
    expect(attempt?.outcome).toBe(ATTEMPT_OUTCOME_LOST);

    coordinator.dispose();
    db.close();
  });
});

function connectedAgentsDelete(
  opts: { connectedAgents: Map<string, ConnectedAgent> },
  agentId: string,
): void {
  opts.connectedAgents.delete(agentId);
}
