import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity, signNonce } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { createMockAgentCapability } from '@rbo/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentConnection } from '../../agent/src/connection/client.js';
import { listAgents } from '../src/agents/service.js';
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
  plane = await startAgentPlaneServer({ port: 0, db, identity });
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

function agentConnection(stateDir: string, fingerprint?: string): AgentConnection {
  return new AgentConnection({
    controllerUrl: `wss://127.0.0.1:${plane.port}/agent`,
    expectedFingerprint: fingerprint ?? identity.fingerprint,
    stateDir,
    displayName: 'test-agent',
    capabilities: createMockAgentCapability({ display_name: 'test-agent' }),
  });
}

describe('Agent pairing over TLS WebSocket (Phase 2)', () => {
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

  it('a revoked agent cannot authenticate again', async () => {
    const dir = newAgentDir();
    const conn = agentConnection(dir);
    await conn.connectOnce(); // pairing request
    const request = latestPendingRequest();
    if (!request) throw new Error('missing request');
    const { agentId } = approvePairingRequest(db, identity, request.id);
    const session = await conn.connectOnce();
    expect(session.status).toBe('authenticated');
    conn.close();

    const { revokeAgent } = await import('../src/agents/registry.js');
    revokeAgent(db, agentId);

    const conn2 = agentConnection(dir);
    const denied = await conn2.connectOnce();
    expect(denied.status).toBe('rejected');
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

  it('agent keeps a stable ID across reconnects (service restart §35 Phase 2)', async () => {
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
});
