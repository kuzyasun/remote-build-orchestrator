import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAttemptLogs, readLogsFromCursor } from '@rbo/executor';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleRemoteLogChunk } from '../src/execution/remote-execution.js';
import { attemptLogDir } from '../src/execution/runner.js';
import { createJob, getAttempt, transitionJobState } from '../src/jobs/lifecycle.js';
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

describe('Controller idempotent log_chunk + log_ack', () => {
  let dataDir: string;

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setup() {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-log-spool-'));
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

    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_log_spool',
      initialState: 'queued',
      request: {
        client_request_id: 'req_log_spool',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = 'att_log_1';
    const leaseId = 'lease_log_1';
    const futureDeadline = new Date(Date.now() + 60_000).toISOString();
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, job.id, 'agt_1', leaseId, futureDeadline);

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

    const opts = {
      db,
      identity,
      dataDir,
      connectedAgents,
      serverPort: 0,
    };

    return { db, opts, socket, attemptId, leaseId };
  }

  it('appends sequence=1 and emits log_ack; replay does not duplicate; gap ignored', async () => {
    const { db, opts, socket, attemptId, leaseId } = await setup();

    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'hello',
    });

    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(1);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.type).toBe('log_ack');
    expect(socket.sent[0]?.payload).toMatchObject({
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      sequence: 1,
    });

    const logDir = attemptLogDir(dataDir, attemptId);
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('hello');

    // Replay same sequence — no duplicate bytes; re-ack
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'hello',
    });
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('hello');
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(1);
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]?.type).toBe('log_ack');
    expect(socket.sent[1]?.payload).toMatchObject({ sequence: 1 });

    // Gap: sequence=3 before 2 — ignore, no append
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 3,
      bytes: 'gap',
    });
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('hello');
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(1);
    expect(socket.sent).toHaveLength(2);

    // Contiguous sequence=2 appends
    await handleRemoteLogChunk(opts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 2,
      bytes: ' world',
    });
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('hello world');
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(2);
    expect(socket.sent.at(-1)?.type).toBe('log_ack');
    expect(socket.sent.at(-1)?.payload).toMatchObject({ sequence: 2 });

    // job_logs cursor reads durable bytes once
    const logs = await ensureAttemptLogs(logDir);
    const chunk = await readLogsFromCursor(logs, 0, 10_000, ['stdout']);
    expect(chunk.data).toBe('hello world');
    expect(chunk.nextCursor).toBe(Buffer.byteLength('hello world'));

    db.close();
  });
});
