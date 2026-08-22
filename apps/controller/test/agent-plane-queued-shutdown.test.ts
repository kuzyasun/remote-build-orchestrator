import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { createMockAgentCapability } from '@rbo/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConnection } from '../../agent/src/connection/client.js';
import { createJob, getJob } from '../src/jobs/lifecycle.js';
import { approvePairingRequest } from '../src/security/pairing.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import { startAgentPlaneServer } from '../src/websocket/server.js';

const queuedDispatch = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  markSourceRequirementsRead: null as (() => void) | null,
  remoteStart: vi.fn(),
  localStart: vi.fn(),
}));

vi.mock('../src/execution/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execution/runner.js')>();
  return {
    ...actual,
    readGitSourceRequirements: async () => {
      queuedDispatch.markSourceRequirementsRead?.();
      if (queuedDispatch.gate) {
        await queuedDispatch.gate;
      }
      return { submodules: false, lfs: false };
    },
    runLocalJob: queuedDispatch.localStart,
  };
});

vi.mock('../src/execution/remote-execution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execution/remote-execution.js')>();
  return {
    ...actual,
    initiateRemoteAttempt: queuedDispatch.remoteStart,
  };
});

describe('agent-plane queued dispatch shutdown', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    queuedDispatch.gate = null;
    queuedDispatch.markSourceRequirementsRead = null;
    queuedDispatch.remoteStart.mockReset();
    queuedDispatch.localStart.mockReset();
    for (const path of cleanupPaths.splice(0)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not start queued work that finishes source inspection during shutdown', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rbo-agent-plane-queued-shutdown-'));
    cleanupPaths.push(dataDir);
    const agentStateDir = join(dataDir, 'agent-state');
    const db = openDatabase(join(dataDir, 'controller.db'));
    migrateToLatest(db);
    const identity = await ensureControllerIdentity(dataDir);
    const plane = await startAgentPlaneServer({
      port: 0,
      db,
      identity,
      dataDir,
      dispatchContext: {
        dataDir,
        allowedProjectRoots: [dataDir],
        maxConcurrentJobs: 1,
        allowLocalFallback: true,
      },
    });
    const pendingConnection = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${plane.port}/agent`,
      expectedFingerprint: identity.fingerprint,
      stateDir: agentStateDir,
      displayName: 'queued-shutdown-agent',
      capabilities: createMockAgentCapability({ display_name: 'queued-shutdown-agent' }),
    });
    let authenticatedConnection: AgentConnection | undefined;

    try {
      const job = createJob(db, {
        clientId: 'queued-shutdown-client',
        clientRequestId: 'queued-shutdown-request',
        initialState: 'queued',
        request: {
          client_request_id: 'queued-shutdown-request',
          source: { project_root: dataDir, cwd: '.' },
          execution: { script: 'echo queued-shutdown' },
          queue_policy: 'wait',
        },
      });

      const sourceRequirementsRead = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      queuedDispatch.gate = gate.promise;
      queuedDispatch.markSourceRequirementsRead = sourceRequirementsRead.resolve;

      expect((await pendingConnection.connectOnce()).status).toBe('pairing_pending');
      pendingConnection.close();
      const request = db
        .prepare(
          "SELECT id FROM pairing_requests WHERE state = 'pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: string };
      approvePairingRequest(db, identity, request.id);

      authenticatedConnection = new AgentConnection({
        controllerUrl: `wss://127.0.0.1:${plane.port}/agent`,
        expectedFingerprint: identity.fingerprint,
        stateDir: agentStateDir,
        displayName: 'queued-shutdown-agent',
        capabilities: createMockAgentCapability({ display_name: 'queued-shutdown-agent' }),
      });
      expect((await authenticatedConnection.connectOnce()).status).toBe('authenticated');
      await sourceRequirementsRead.promise;

      const closePromise = plane.close();
      gate.resolve();
      await closePromise;

      expect(queuedDispatch.remoteStart).not.toHaveBeenCalled();
      expect(queuedDispatch.localStart).not.toHaveBeenCalled();
      expect(getJob(db, job.id)?.state).toBe('queued');
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
