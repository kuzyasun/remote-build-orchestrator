import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  expireStaleLeases,
  handleRemoteCleanupComplete,
  handleRemoteJobExit,
  handleRemoteLeaseReject,
  initiateRemoteAttempt,
  requestRemoteJobCancel,
} from '../src/execution/remote-execution.js';
import { createJob, getJob, persistSnapshot, transitionJobState } from '../src/jobs/lifecycle.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function mockSocket(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1, // OPEN
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

describe('Phase 4 remote cancel + lease_reject rematch', () => {
  it('requestRemoteJobCancel sends typed cancel_job with attempt/lease/epoch', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_cancel',
      initialState: 'queued',
      request: {
        client_request_id: 'req_cancel',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi', cancel_grace_seconds: 7 },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'leasing');

    const attemptId = 'att_cancel_1';
    const leaseId = 'lease_cancel_1';
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, nowIso());

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

    const sent = requestRemoteJobCancel({ db, connectedAgents }, job.id, 'operator cancel');
    expect(sent).toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.type).toBe('cancel_job');
    expect(socket.sent[0]?.attempt_id).toBe(attemptId);
    expect(socket.sent[0]?.lease_id).toBe(leaseId);
    expect(socket.sent[0]?.lease_epoch).toBe(1);
    expect(socket.sent[0]?.payload).toMatchObject({
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      grace_seconds: 7,
      reason: 'operator cancel',
    });

    // Cancel must not mark the job terminal — Agent exit/cleanup does.
    expect(getJob(db, job.id)?.state).toBe('leasing');
    db.close();
  });

  it('lease_reject re-queues wait jobs instead of terminal no_capacity', () => {
    const db = openDatabase(':memory:');
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

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_reject_wait',
      initialState: 'queued',
      request: {
        client_request_id: 'req_reject_wait',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'leasing');

    const attemptId = 'att_reject_1';
    const leaseId = 'lease_reject_1';
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'leasing')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, new Date(Date.now() + 60_000).toISOString());

    handleRemoteLeaseReject(
      {
        db,
        identity: identity as never,
        dataDir: '/tmp',
        connectedAgents: new Map(),
        serverPort: 7411,
      },
      'agt_1',
      {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: 1,
        reason: 'Agent capacity limit reached (1 active job max)',
      },
    );

    const after = getJob(db, job.id);
    expect(after?.state).toBe('queued');
    expect(after?.outcome).toBeNull();
    expect(after?.failure_category).toBeNull();
    expect(after?.finished_at).toBeNull();

    const attempt = db
      .prepare('SELECT state, outcome FROM job_attempts WHERE id = ?')
      .get(attemptId) as { state: string; outcome: string };
    expect(attempt.state).toBe('completed');
    expect(attempt.outcome).toBe('failed');
    db.close();
  });

  it('lease_reject still fails fail_fast jobs', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_reject_ff',
      initialState: 'queued',
      request: {
        client_request_id: 'req_reject_ff',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'fail_fast',
      },
    });
    transitionJobState(db, job.id, 'leasing');

    const attemptId = 'att_reject_ff';
    const leaseId = 'lease_reject_ff';
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'leasing')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, new Date(Date.now() + 60_000).toISOString());

    handleRemoteLeaseReject(
      {
        db,
        identity: {} as never,
        dataDir: '/tmp',
        connectedAgents: new Map(),
        serverPort: 7411,
      },
      'agt_1',
      {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: 1,
        reason: 'busy',
      },
    );

    const after = getJob(db, job.id);
    expect(after?.state).toBe('completed');
    expect(after?.outcome).toBe('failed');
    expect(after?.failure_category).toBe('no_capacity');
    db.close();
  });

  it('rematch after lease_reject can create a second attempt (ordinal must advance)', async () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const snapshotId = 'snp_rematch';
    persistSnapshot(db, {
      snapshotId,
      contentId: 'cid_rematch',
      repoId: 'repo',
      baseCommit: null,
      dirty: true,
      manifestPath: '/tmp/manifest.json',
      payloadPath: '/tmp/payload.tar.zst',
      sizeBytes: 12,
      sha256: 'abc123',
    });

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_rematch_ordinal',
      initialState: 'queued',
      request: {
        client_request_id: 'req_rematch_ordinal',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'queued', { snapshot_id: snapshotId });

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

    const remoteOpts = {
      db,
      identity: {} as never,
      dataDir: '/tmp',
      connectedAgents,
      serverPort: 7411,
    };

    const firstAttemptId = await initiateRemoteAttempt(remoteOpts, job.id, 'agt_1');
    handleRemoteLeaseReject(remoteOpts, 'agt_1', {
      attempt_id: firstAttemptId,
      lease_id: (
        db.prepare('SELECT lease_id FROM job_attempts WHERE id = ?').get(firstAttemptId) as {
          lease_id: string;
        }
      ).lease_id,
      lease_epoch: 1,
      reason: 'Agent capacity limit reached (1 active job max)',
    });
    expect(getJob(db, job.id)?.state).toBe('queued');

    // Rematch after a completed first attempt must insert a new ordinal (not reuse 1).
    await expect(initiateRemoteAttempt(remoteOpts, job.id, 'agt_1')).resolves.toBeTypeOf('string');

    const ordinals = (
      db
        .prepare('SELECT ordinal FROM job_attempts WHERE job_id = ? ORDER BY ordinal ASC')
        .all(job.id) as Array<{ ordinal: number }>
    ).map((row) => row.ordinal);
    expect(ordinals).toEqual([1, 2]);
    db.close();
  });

  it('lease expiry marks attempts agent_disconnected per Phase 4 lease policy', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_lease_exp',
      initialState: 'queued',
      request: {
        client_request_id: 'req_lease_exp',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = 'att_lease_exp';
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, job.id, 'agt_1', 'lease_exp', new Date(Date.now() - 1000).toISOString());

    expireStaleLeases(db);

    const after = getJob(db, job.id);
    expect(after?.state).toBe('completed');
    expect(after?.outcome).toBe('failed');
    // Phase 4: "On lease expiry or connection loss, mark the attempt terminal as agent_disconnected"
    expect(after?.failure_category).toBe('agent_disconnected');
    db.close();
  });

  it('cleanup_complete keeps cancelled exit_code null instead of adopting cleanup script exit 0', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_cleanup_exit',
      initialState: 'queued',
      request: {
        client_request_id: 'req_cleanup_exit',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = 'att_cleanup_exit';
    const leaseId = 'lease_cleanup_exit';
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, new Date(Date.now() + 60_000).toISOString());

    const opts = {
      db,
      identity: {} as never,
      dataDir: '/tmp',
      connectedAgents: new Map(),
      serverPort: 7411,
    };

    handleRemoteJobExit(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      exit_code: null,
      outcome: 'cancelled',
      failure_category: 'cancelled',
      failure_message: 'operator cancel',
    });

    handleRemoteCleanupComplete(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      exit_code: 0,
      timed_out: false,
      message: 'cleanup ok',
    });

    const after = getJob(db, job.id);
    expect(after?.outcome).toBe('cancelled');
    // Job process never exited with 0; cleanup script success must not overwrite null exit_code.
    expect(after?.exit_code).toBeNull();
    db.close();
  });
});
