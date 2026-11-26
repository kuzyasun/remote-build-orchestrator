import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity, signNonce } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { createMockAgentCapability } from '@rbo/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AgentConnection } from '../../agent/src/connection/client.js';
import type { AgentJobExecutor } from '../../agent/src/executor/index.js';
import { writeAttemptMetadata } from '../../agent/src/recovery/attempt-metadata.js';
import { AgentRecoveryCoordinator } from '../../agent/src/recovery/coordinator.js';
import { requestAgentProbe } from '../src/agents/probe.js';
import { listAgents } from '../src/agents/service.js';
import { handleAdminRequest } from '../src/http/admin.js';
import {
  createAttempt,
  createJob,
  getAttempt,
  getJob,
  updateAttempt,
} from '../src/jobs/lifecycle.js';
import { approvePairingRequest, listPairingRequests } from '../src/security/pairing.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';
import { startAgentPlaneServer } from '../src/websocket/server.js';
import type { RunningAgentPlane } from '../src/websocket/server.js';

let db: ControllerDatabase;
let identity: ControllerIdentity;
let plane: RunningAgentPlane;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rbo-plane-'));
  db = openDatabase(':memory:');
  migrateToLatest(db);
  identity = await ensureControllerIdentity(dataDir);
  plane = await startAgentPlaneServer({ port: 0, db, identity, dataDir });
});

afterAll(async () => {
  await plane.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function newAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-agent-'));
  return dir;
}

// db is shared across tests in this file (one TLS agent plane for all of
// them), so an earlier test's still-pending request (e.g. the "no credential
// yet" case) must never be picked up by a later test — always take the most
// recently created pending request, since tests run sequentially.
function latestPendingRequest() {
  const pending = listPairingRequests(db, 'pending');
  return pending[pending.length - 1];
}

function agentConnection(stateDir: string, fingerprint?: string, bootId?: string): AgentConnection {
  return new AgentConnection({
    controllerUrl: `wss://127.0.0.1:${plane.port}/agent`,
    expectedFingerprint: fingerprint ?? identity.fingerprint,
    stateDir,
    displayName: 'test-agent',
    capabilities: createMockAgentCapability({ display_name: 'test-agent', boot_id: bootId }),
    gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
  });
}

describe('Agent pairing over TLS WebSocket', () => {
  it('rejects a controller with the wrong pinned fingerprint before pairing', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir, `sha256:${'0'.repeat(64)}`);
    await expect(conn.connectOnce()).rejects.toThrow(/fingerprint/i);
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('performs pairing → approval → credential claim → authenticated session', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);

    // 1. First connect: agent submits a pairing request and waits.
    const first = await conn.connectOnce();
    expect(first.status).toBe('pairing_pending');

    const pending = listPairingRequests(db, 'pending');
    expect(pending).toHaveLength(1);

    // 2. Operator approves out-of-band.
    const request = pending[0];
    if (!request) throw new Error('missing request');
    const { agentId } = approvePairingRequest(db, identity, request.id);

    // 3. Second connect: agent claims its credential and authenticates.
    const second = await conn.connectOnce();
    expect(second.status).toBe('authenticated');
    expect(second.agentId).toBe(agentId);

    // Agent state directory now holds the private key and credential.
    expect(conn.hasStoredCredential()).toBe(true);

    // Controller sees the agent online with capabilities.
    const agents = listAgents(db, true);
    expect(agents.map((a) => a.id)).toContain(agentId);

    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a revoked agent drops its credential and requests pairing again', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    await conn.connectOnce(); // pairing request
    const request = latestPendingRequest();
    if (!request) throw new Error('missing request');
    const { agentId } = approvePairingRequest(db, identity, request.id);
    const session = await conn.connectOnce();
    expect(session.status).toBe('authenticated');

    const disconnected = conn.waitUntilDisconnected();
    await handleAdminRequest({ db, connectedAgents: plane.connectedAgents }, 'agents/revoke', {
      agent_id: agentId,
    });
    await disconnected;
    await vi.waitFor(() => expect(plane.connectedAgents.has(agentId)).toBe(false));
    expect(db.prepare('SELECT state FROM agents WHERE id = ?').get(agentId)).toEqual({
      state: 'revoked',
    });
    conn.close();

    const conn2 = agentConnection(dir);
    const denied = await conn2.connectOnce();
    expect(denied.status).toBe('pairing_pending');
    expect(conn2.hasStoredCredential()).toBe(false);
    conn2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('an unpaired agent gets no job metadata: hello without credential is not authenticated', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    const result = await conn.connectOnce();
    expect(result.status).toBe('pairing_pending');
    expect(result.agentId).toBeUndefined();
    conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('agent keeps a stable ID across reconnects (service restart §35)', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    await conn.connectOnce();
    const request = latestPendingRequest();
    if (!request) throw new Error('missing request');
    approvePairingRequest(db, identity, request.id);
    const a = await conn.connectOnce();
    conn.close();

    // Fresh connection object from the same state dir — simulates restart.
    const conn2 = agentConnection(dir);
    const b = await conn2.connectOnce();
    conn2.close();

    expect(a.status).toBe('authenticated');
    expect(b.status).toBe('authenticated');
    expect(b.agentId).toBe(a.agentId);

    const persisted = JSON.parse(readFileSync(join(dir, 'agent-state.json'), 'utf8')) as {
      agentId?: string;
      devicePrivateKeyPem: string;
    };
    expect(persisted.agentId).toBe(a.agentId);
    expect(persisted.devicePrivateKeyPem).toMatch(/BEGIN PRIVATE KEY/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('defers refresh and lease renewal while scanning for durable exits on a new session', async () => {
    const dir = newAgentDir();
    const original = agentConnection(dir, undefined, 'boot_old');
    const reconnect = agentConnection(dir, undefined, 'boot_new');
    const unblockScan = Promise.withResolvers<void>();
    const originalReportAll = AgentRecoveryCoordinator.prototype.reportAll;
    const scan = vi.spyOn(AgentRecoveryCoordinator.prototype, 'reportAll');
    try {
      await original.connectOnce();
      const request = latestPendingRequest();
      if (!request) throw new Error('Missing pairing fixture');
      const { agentId } = approvePairingRequest(db, identity, request.id);
      await original.connectOnce();
      await vi.waitFor(() =>
        expect(plane.connectedAgents.get(agentId)?.capabilitiesReady).toBe(true),
      );
      original.close();
      await vi.waitFor(() => expect(plane.connectedAgents.has(agentId)).toBe(false));

      const job = createJob(db, {
        clientId: 'test',
        clientRequestId: 'req_deferred_capabilities',
        initialState: 'running',
        request: {
          client_request_id: 'req_deferred_capabilities',
          source: { project_root: dir, cwd: '.' },
          execution: { script: 'echo done' },
        },
      });
      const attempt = createAttempt(db, job.id, 1);
      const deadline = new Date(Date.now() + 45_000).toISOString();
      updateAttempt(db, attempt.id, {
        agent_id: agentId,
        state: 'running',
        lease_deadline: deadline,
      });
      writeAttemptMetadata(dir, {
        attempt_id: attempt.id,
        job_id: job.id,
        lease_id: attempt.lease_id,
        lease_epoch: attempt.lease_epoch,
        process_identity: null,
        status: 'completed_awaiting_upload',
        workspace_path: null,
        spool_dir: join(dir, 'logs', attempt.id),
        risk_level: 'normal',
        updated_at: new Date().toISOString(),
        last_exit: { exit_code: 0, outcome: 'succeeded' },
        artifact_staging: 'complete',
        artifact_manifest: [],
        cleanup_result: { exit_code: 0, timed_out: false },
      });

      scan.mockImplementationOnce(async function (this: AgentRecoveryCoordinator, beforeReports) {
        await unblockScan.promise;
        await originalReportAll.call(this, beforeReports);
      });
      const connecting = reconnect.connectOnce();
      await vi.waitFor(() =>
        expect(plane.connectedAgents.get(agentId)?.capabilitiesReady).toBe(false),
      );
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
      const socket = (reconnect as unknown as { socket: WebSocket }).socket;
      const receivedProbe = once(socket, 'message');
      expect(requestAgentProbe(plane.connectedAgents, agentId)).toEqual({ requested: true });
      await receivedProbe;
      socket.send(JSON.stringify({ type: 'heartbeat', payload: { state: 'busy' } }));
      const pong = once(socket, 'pong');
      socket.ping();
      await pong;

      expect(plane.connectedAgents.get(agentId)?.capabilitiesReady).toBe(false);
      expect(getAttempt(db, attempt.id)).toMatchObject({
        state: 'running',
        outcome: null,
        lease_deadline: deadline,
      });

      unblockScan.resolve();
      await expect(connecting).resolves.toMatchObject({ status: 'authenticated', agentId });
      await vi.waitFor(() =>
        expect(getJob(db, job.id)).toMatchObject({ state: 'completed', outcome: 'succeeded' }),
      );
    } finally {
      scan.mockRestore();
      unblockScan.resolve();
      original.close();
      reconnect.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('confirms SQLite renewals once per heartbeat, including a delayed acknowledgement', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    try {
      await conn.connectOnce();
      const { agentId } = approvePairingRequest(db, identity, latestPendingRequest().id);
      await expect(conn.connectOnce()).resolves.toMatchObject({ status: 'authenticated', agentId });
      const { socket, executor } = conn as unknown as {
        socket: WebSocket;
        executor: AgentJobExecutor;
      };
      const controllerSocket = plane.connectedAgents.get(agentId)?.socket;
      if (!controllerSocket) throw new Error('missing connected agent');

      // Drain the initial heartbeat before instrumenting subsequent exchanges.
      const pong = once(socket, 'pong');
      socket.ping();
      await pong;

      const requestId = 'req_heartbeat_ack';
      const job = createJob(db, {
        clientId: 'test',
        clientRequestId: requestId,
        initialState: 'running',
        request: {
          client_request_id: requestId,
          source: { project_root: dir, cwd: '.' },
          execution: { script: 'echo done' },
        },
      });
      const current = createAttempt(db, job.id, 1);
      const expired = createAttempt(db, job.id, 2);
      const completed = createAttempt(db, job.id, 3);
      const unassigned = createAttempt(db, job.id, 4);
      const longer = createAttempt(db, job.id, 5);
      const liveDeadline = new Date(Date.now() + 60_000).toISOString();
      const expiredDeadline = new Date(Date.now() - 5_000).toISOString();
      const longerDeadline = new Date(Date.now() + 900_000).toISOString();
      updateAttempt(db, current.id, {
        agent_id: agentId,
        state: 'running',
        lease_deadline: liveDeadline,
      });
      updateAttempt(db, expired.id, {
        agent_id: agentId,
        state: 'running',
        lease_deadline: expiredDeadline,
      });
      updateAttempt(db, completed.id, {
        agent_id: agentId,
        state: 'completed',
        lease_deadline: liveDeadline,
      });
      updateAttempt(db, unassigned.id, { state: 'running', lease_deadline: liveDeadline });
      updateAttempt(db, longer.id, {
        agent_id: agentId,
        state: 'running',
        lease_deadline: longerDeadline,
      });

      const confirm = vi.spyOn(executor, 'confirmLeaseRenewal');
      const responses: string[] = [];
      const transmit = controllerSocket.send.bind(controllerSocket);
      const capture = vi.spyOn(controllerSocket, 'send').mockImplementation((frame) => {
        responses.push(String(frame));
      });
      const heartbeat = conn as unknown as { sendHeartbeat(socket: WebSocket): void };
      try {
        heartbeat.sendHeartbeat(socket);
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        expect(confirm).not.toHaveBeenCalled();
        expect(Date.parse(getAttempt(db, current.id)?.lease_deadline ?? '')).toBeGreaterThan(
          Date.parse(liveDeadline),
        );
        expect(getAttempt(db, expired.id)?.lease_deadline).toBe(expiredDeadline);
        expect(getAttempt(db, completed.id)?.lease_deadline).toBe(liveDeadline);
        expect(getAttempt(db, unassigned.id)?.lease_deadline).toBe(liveDeadline);
        expect(getAttempt(db, longer.id)?.lease_deadline).toBe(longerDeadline);

        const secondSendAt = Date.now();
        heartbeat.sendHeartbeat(socket);
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        const delayedReceived = once(socket, 'message');
        transmit(responses[0]);
        await delayedReceived;
        expect(confirm).toHaveBeenCalledTimes(1);

        transmit(responses[1]);
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
        expect(confirm).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            lease_ttl_seconds: 300,
            renewed_leases: expect.arrayContaining(
              [current, longer].map((attempt) => ({
                attempt_id: attempt.id,
                lease_id: attempt.lease_id,
                lease_epoch: attempt.lease_epoch,
              })),
            ),
          }),
          expect.objectContaining({ epochMs: expect.any(Number), monotonicMs: expect.any(Number) }),
        );
        const [[firstAck, firstClock], [secondAck, secondClock]] = confirm.mock.calls;
        expect(firstAck.renewed_leases).toHaveLength(2);
        expect(secondAck.renewed_leases).toEqual(firstAck.renewed_leases);
        expect(firstAck.heartbeat_message_id).not.toBe(secondAck.heartbeat_message_id);
        expect(firstClock.monotonicMs).toBeLessThan(secondClock.monotonicMs);
        expect(secondClock.epochMs).toBeGreaterThanOrEqual(secondSendAt);

        const replayReceived = once(socket, 'message');
        transmit(responses[0]);
        await replayReceived;
        expect(confirm).toHaveBeenCalledTimes(2);
      } finally {
        capture.mockRestore();
        confirm.mockRestore();
      }
    } finally {
      conn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries authentication after an unreadable recovery directory', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    try {
      await conn.connectOnce();
      const request = latestPendingRequest();
      if (!request) throw new Error('Missing pairing fixture');
      const { agentId } = approvePairingRequest(db, identity, request.id);

      // The attempts path being a file makes the directory scan fail on every platform.
      const attemptsPath = join(dir, 'attempts');
      writeFileSync(attemptsPath, '');
      await expect(conn.connectOnce()).rejects.toThrow(
        'Could not prepare initial Agent capabilities',
      );
      await vi.waitFor(() => expect(plane.connectedAgents.has(agentId)).toBe(false));

      rmSync(attemptsPath);
      await expect(conn.connectOnce()).resolves.toMatchObject({ status: 'authenticated', agentId });
    } finally {
      conn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a reconnect after heartbeat expiry even while the stale socket is still open', async () => {
    const dir = newAgentDir();
    const first = agentConnection(dir);
    await first.connectOnce();
    const request = latestPendingRequest();
    if (!request) throw new Error('missing request');
    const { agentId } = approvePairingRequest(db, identity, request.id);
    const session = await first.connectOnce();
    expect(session.status).toBe('authenticated');

    await vi.waitFor(() =>
      expect(plane.connectedAgents.get(agentId)?.capabilitiesReady).toBe(true),
    );
    const previous = plane.connectedAgents.get(agentId);
    if (!previous) throw new Error('missing connected agent');
    const previousSocket = previous.socket;
    expect(previousSocket?.readyState).toBe(WebSocket.OPEN);
    previous.lastHeartbeatAt = 0;

    const second = agentConnection(dir);
    const again = await second.connectOnce();
    expect(again.status).toBe('authenticated');
    expect(again.agentId).toBe(agentId);

    const current = plane.connectedAgents.get(agentId);
    expect(current?.socket).toBeDefined();
    expect(current?.socket).not.toBe(previousSocket);
    expect(current?.socket.readyState).toBe(WebSocket.OPEN);

    await new Promise<void>((resolvePromise) => {
      if (!previousSocket || previousSocket.readyState === WebSocket.CLOSED) {
        resolvePromise();
        return;
      }
      previousSocket.once('close', () => resolvePromise());
      first.close();
    });

    expect(plane.connectedAgents.get(agentId)?.socket).toBe(current?.socket);
    expect(listAgents(db, false).map((agent) => agent.id)).toContain(agentId);

    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a replayed pairing challenge signature from a stale connection is rejected on a fresh one', async () => {
    // Capture a valid (nonce, signature) pair from one connection, then try
    // to replay it against a second, independent challenge — each connection
    // gets its own server-generated nonce, so a captured pair never matches.
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    await conn.connectOnce();
    const request = latestPendingRequest();
    if (!request) throw new Error('missing request');
    approvePairingRequest(db, identity, request.id);
    await conn.connectOnce(); // claims credential, authenticates
    conn.close();

    const state = JSON.parse(readFileSync(join(dir, 'agent-state.json'), 'utf8')) as {
      devicePrivateKeyPem: string;
      credential: string;
    };

    const capturedNonce = await new Promise<string>((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(`wss://127.0.0.1:${plane.port}/agent`, {
        rejectUnauthorized: false,
      });
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            protocol: 1,
            type: 'hello',
            payload: { min_version: 1, max_version: 1, credential: state.credential },
          }),
        );
      });
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; payload?: { nonce?: string } };
        if (msg.type === 'pairing_challenge' && msg.payload?.nonce) {
          resolvePromise(msg.payload.nonce);
          socket.close();
        }
      });
      socket.on('error', rejectPromise);
    });
    const capturedSignature = signNonce(state.devicePrivateKeyPem, capturedNonce);

    const replayAccepted = await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(`wss://127.0.0.1:${plane.port}/agent`, {
        rejectUnauthorized: false,
      });
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            protocol: 1,
            type: 'hello',
            payload: { min_version: 1, max_version: 1, credential: state.credential },
          }),
        );
      });
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as {
          type: string;
          payload?: { status?: string; nonce?: string };
        };
        if (msg.type === 'pairing_challenge') {
          // Reuse the OLD signature against this NEW challenge's nonce.
          socket.send(
            JSON.stringify({
              protocol: 1,
              type: 'challenge_response',
              payload: { signature: capturedSignature },
            }),
          );
          return;
        }
        if (msg.type === 'hello_ack') {
          resolvePromise(msg.payload?.status === 'authenticated');
          socket.close();
        }
      });
      socket.on('error', rejectPromise);
    });

    expect(replayAccepted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores the device private key and agent state with owner-only permissions where the OS enforces it', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    await conn.connectOnce();
    conn.close();

    const statePath = join(dir, 'agent-state.json');
    expect(existsSync(statePath)).toBe(true);

    if (process.platform !== 'win32') {
      const mode = statSync(statePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('terminates connection and updates state to offline when heartbeats time out', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'rbo-hb-plane-'));
    const testDb = openDatabase(':memory:');
    migrateToLatest(testDb);
    const testIdentity = await ensureControllerIdentity(testDir);
    const fastPlane = await startAgentPlaneServer({
      port: 0,
      db: testDb,
      identity: testIdentity,
      dataDir: testDir,
      heartbeatTimeoutMs: 50,
      leaseSweepIntervalMs: 25,
    });

    const agentDir = newAgentDir();
    const conn = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${fastPlane.port}/agent`,
      expectedFingerprint: testIdentity.fingerprint,
      stateDir: agentDir,
      displayName: 'test-agent',
      capabilities: createMockAgentCapability({ display_name: 'test-agent' }),
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
    });

    await conn.connectOnce();
    const pending = listPairingRequests(testDb, 'pending');
    const req = pending[0];
    if (!req) throw new Error('missing request');
    const { agentId } = approvePairingRequest(testDb, testIdentity, req.id);

    const session = await conn.connectOnce();
    expect(session.status).toBe('authenticated');

    const connected = fastPlane.connectedAgents.get(agentId);
    expect(connected).toBeDefined();

    // Verify it is listed as idle in listAgents with live connectedAgents
    const listedActive = listAgents(testDb, false, fastPlane.connectedAgents);
    expect(listedActive.map((a) => a.id)).toContain(agentId);

    // Stop client heartbeat emissions so the socket remains open without new heartbeats
    (conn as unknown as { stopHeartbeats(): void }).stopHeartbeats();

    // Age lastHeartbeatAt beyond the 50ms threshold
    if (connected) {
      connected.lastHeartbeatAt = Date.now() - 100;
    }

    // Wait for the socket close triggered by checkHeartbeats
    const socket = connected?.socket;
    await new Promise<void>((resolvePromise) => {
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        resolvePromise();
        return;
      }
      socket.once('close', () => resolvePromise());
      const interval = setInterval(() => {
        if (!fastPlane.connectedAgents.has(agentId)) {
          clearInterval(interval);
          resolvePromise();
        }
      }, 20);
    });

    expect(fastPlane.connectedAgents.has(agentId)).toBe(false);
    const listedOffline = listAgents(testDb, true, fastPlane.connectedAgents);
    const agent = listedOffline.find((a) => a.id === agentId);
    expect(agent?.state).toBe('offline');

    conn.close();
    await fastPlane.close();
    rmSync(testDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
});
