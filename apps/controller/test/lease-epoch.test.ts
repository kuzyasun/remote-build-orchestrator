import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleRemoteLeaseAccept,
  initiateRemoteAttempt,
} from '../src/execution/remote-execution.js';
import {
  bumpLeaseEpoch,
  createJob,
  getAttempt,
  persistSnapshot,
  transitionJobState,
} from '../src/jobs/lifecycle.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function mockSocket(): WebSocket {
  return {
    readyState: 1,
    OPEN: 1,
    send() {},
  } as unknown as WebSocket;
}

function insertAgent(db: ReturnType<typeof openDatabase>, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
     VALUES (?, ?, ?, 'offline', '{}', ?)`,
  ).run(agentId, agentId, 'localhost', nowIso());
}

describe('lease_epoch monotonic fencing (§2.2)', () => {
  it('initiateRemoteAttempt increments epoch across rematch attempts on the same job', async () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const snapshotId = 'snp_epoch';
    persistSnapshot(db, {
      snapshotId,
      contentId: 'cid_epoch',
      repoId: 'local',
      baseCommit: null,
      dirty: false,
      manifestPath: '/tmp/manifest.json',
      payloadPath: '/tmp/payload.bin',
      sizeBytes: 64,
      sha256: 'a'.repeat(64),
    });

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_epoch',
      initialState: 'queued',
      request: {
        client_request_id: 'req_epoch',
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
    const firstEpoch = (
      db.prepare('SELECT lease_epoch FROM job_attempts WHERE id = ?').get(firstAttemptId) as {
        lease_epoch: number;
      }
    ).lease_epoch;

    db.prepare(`UPDATE job_attempts SET state = 'completed', outcome = 'failed' WHERE id = ?`).run(
      firstAttemptId,
    );

    const secondAttemptId = await initiateRemoteAttempt(remoteOpts, job.id, 'agt_1');
    const secondEpoch = (
      db.prepare('SELECT lease_epoch FROM job_attempts WHERE id = ?').get(secondAttemptId) as {
        lease_epoch: number;
      }
    ).lease_epoch;

    expect(firstEpoch).toBe(1);
    expect(secondEpoch).toBeGreaterThanOrEqual(firstEpoch + 1);
    db.close();
  });

  it('stale lease_epoch on lease_accept is ignored after explicit re-fence', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_stale_epoch',
      initialState: 'queued',
      request: {
        client_request_id: 'req_stale_epoch',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'leasing');

    const attemptId = 'att_stale_epoch';
    const leaseId = 'lease_stale_epoch';
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'leasing')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, new Date(Date.now() + 60_000).toISOString());

    bumpLeaseEpoch(db, attemptId);
    expect(getAttempt(db, attemptId)?.lease_epoch).toBe(2);

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

    handleRemoteLeaseAccept(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
    });
    expect(getAttempt(db, attemptId)?.state).toBe('leasing');
    db.close();
  });
});
