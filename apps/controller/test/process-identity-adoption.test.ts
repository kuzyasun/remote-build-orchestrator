import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProcessIdentity } from '@rbo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createJob, getAttempt, transitionJobState } from '../src/jobs/lifecycle.js';
import { RecoveryCoordinator } from '../src/recovery/coordinator.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

const TEST_PID = 4242;
const TEST_START_MS = 1_700_000_000_000;
const TEST_IDENTITY = formatProcessIdentity(TEST_PID, TEST_START_MS);

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

describe('process_identity adoption (Task 9)', () => {
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

  async function setup(processIdentity: string | null) {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-pid-adopt-'));
    const db = openDatabase(join(dataDir, 'controller.db'));
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: `req_pid_${Date.now()}`,
      initialState: 'queued',
      request: {
        client_request_id: 'req_pid',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
        risk_level: 'safe',
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = 'att_pid_1';
    const leaseId = 'lease_pid_1';
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();

    db.prepare(
      `INSERT INTO job_attempts (
         id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state,
         process_identity, log_acked_sequence
       ) VALUES (?, ?, 1, ?, ?, 1, ?, 'running', ?, 3)`,
    ).run(attemptId, job.id, 'agt_1', leaseId, futureDeadline, processIdentity);

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

    const coordinator = new RecoveryCoordinator({
      db,
      connectedAgents,
      disconnectGraceSeconds: 5,
      orphanTimeoutSeconds: 10,
      reconcileDeadlineSeconds: 8,
    });

    return { db, coordinator, socket, attemptId, leaseId };
  }

  it('adopts when process_identity tuple matches', async () => {
    const { db, coordinator, attemptId, leaseId } = await setup(TEST_IDENTITY);

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: TEST_IDENTITY,
      last_sent_sequence: 5,
      last_acked_sequence: 3,
      artifact_upload_pending: false,
    });

    expect(decision.action).toBe('adopt');
    expect(decision.resume_from_sequence).toBe(3);
    expect(getAttempt(db, attemptId)?.process_identity).toBe(TEST_IDENTITY);

    coordinator.dispose();
    db.close();
  });

  it('rejects adoption when Controller process_identity is null (fail closed)', async () => {
    const { db, coordinator, socket, attemptId, leaseId } = await setup(null);

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: TEST_IDENTITY,
      last_sent_sequence: 0,
      last_acked_sequence: 0,
      artifact_upload_pending: false,
    });

    expect(decision.action).toBe('terminate_stale');
    expect(decision.reason).toBe('process_identity_pending');
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.process_identity).toBeNull();
    expect(socket.sent.some((m) => m.type === 'reconcile_decision')).toBe(false);

    coordinator.dispose();
    db.close();
  });

  it('terminate_stale on start-time mismatch (PID reuse fence)', async () => {
    const { db, coordinator, attemptId, leaseId } = await setup(TEST_IDENTITY);

    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: formatProcessIdentity(TEST_PID, TEST_START_MS + 1),
      last_sent_sequence: 0,
      last_acked_sequence: 0,
      artifact_upload_pending: false,
    });

    expect(decision).toMatchObject({
      action: 'terminate_stale',
      reason: 'process_identity_mismatch',
    });
    expect(getAttempt(db, attemptId)?.state).toBe('completed');
    expect(getAttempt(db, attemptId)?.outcome).toBe('failed');

    coordinator.dispose();
    db.close();
  });
});
