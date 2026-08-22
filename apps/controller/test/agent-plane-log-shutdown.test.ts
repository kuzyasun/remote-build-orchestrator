import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { createMockAgentCapability } from '@rbo/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentConnection } from '../../agent/src/connection/client.js';
import { createJob, getAttempt, transitionJobState } from '../src/jobs/lifecycle.js';
import { approvePairingRequest } from '../src/security/pairing.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import { startAgentPlaneServer } from '../src/websocket/server.js';

const logPersistenceGate = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  markStarted: null as (() => void) | null,
}));

vi.mock('../src/logs/stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logs/stream.js')>();
  return {
    ...actual,
    persistAndPublishLogChunk: async (
      input: Parameters<typeof actual.persistAndPublishLogChunk>[0],
    ) => {
      if (logPersistenceGate.gate) {
        logPersistenceGate.markStarted?.();
        await logPersistenceGate.gate;
      }
      return actual.persistAndPublishLogChunk(input);
    },
  };
});

describe('agent-plane log handler shutdown', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    logPersistenceGate.gate = null;
    logPersistenceGate.markStarted = null;
    for (const path of cleanupPaths.splice(0)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('drains an accepted log_chunk before close permits the database to close', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rbo-agent-plane-log-shutdown-'));
    cleanupPaths.push(dataDir);
    const agentStateDir = join(dataDir, 'agent-state');
    const db = openDatabase(join(dataDir, 'controller.db'));
    migrateToLatest(db);
    const identity = await ensureControllerIdentity(dataDir);
    const plane = await startAgentPlaneServer({ port: 0, db, identity, dataDir });
    const pendingConnection = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${plane.port}/agent`,
      expectedFingerprint: identity.fingerprint,
      stateDir: agentStateDir,
      displayName: 'log-shutdown-agent',
      capabilities: createMockAgentCapability({ display_name: 'log-shutdown-agent' }),
    });
    let authenticatedConnection: AgentConnection | undefined;

    try {
      expect((await pendingConnection.connectOnce()).status).toBe('pairing_pending');
      pendingConnection.close();

      const request = db
        .prepare(
          "SELECT id FROM pairing_requests WHERE state = 'pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: string };
      const { agentId } = approvePairingRequest(db, identity, request.id);

      authenticatedConnection = new AgentConnection({
        controllerUrl: `wss://127.0.0.1:${plane.port}/agent`,
        expectedFingerprint: identity.fingerprint,
        stateDir: agentStateDir,
        displayName: 'log-shutdown-agent',
        capabilities: createMockAgentCapability({ display_name: 'log-shutdown-agent' }),
      });
      expect((await authenticatedConnection.connectOnce()).status).toBe('authenticated');

      const job = createJob(db, {
        clientId: 'log-shutdown-client',
        clientRequestId: 'log-shutdown-request',
        initialState: 'queued',
        request: {
          client_request_id: 'log-shutdown-request',
          source: { project_root: dataDir, cwd: '.' },
          execution: { script: 'echo log-shutdown' },
          queue_policy: 'wait',
        },
      });
      transitionJobState(db, job.id, 'running');
      const attemptId = 'att_log_shutdown';
      const leaseId = 'lease_log_shutdown';
      db.prepare(
        `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
         VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
      ).run(attemptId, job.id, agentId, leaseId, new Date(Date.now() + 60_000).toISOString());

      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      logPersistenceGate.gate = gate.promise;
      logPersistenceGate.markStarted = started.resolve;

      const socket = (authenticatedConnection as unknown as { socket: WebSocket | null }).socket;
      if (!socket) {
        throw new Error('authenticated agent socket was unavailable');
      }
      socket.send(
        JSON.stringify({
          protocol: 1,
          type: 'log_chunk',
          payload: {
            attempt_id: attemptId,
            lease_id: leaseId,
            lease_epoch: 1,
            stream: 'stdout',
            sequence: 1,
            bytes: 'late log',
          },
        }),
      );
      await started.promise;

      let closed = false;
      const closePromise = plane.close().then(() => {
        closed = true;
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(closed).toBe(false);

      gate.resolve();
      await closePromise;
      expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(1);

      db.close();
    } finally {
      authenticatedConnection?.close();
      pendingConnection.close();
      if (db.open) {
        await plane.close();
        db.close();
      }
    }
  }, 15_000);
});
