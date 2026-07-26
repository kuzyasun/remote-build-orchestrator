import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity, generateDeviceKeyPair } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startControllerServer } from '../src/http/server.js';
import type { RunningControllerServer } from '../src/http/server.js';
import { createPairingRequest } from '../src/security/pairing.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';

let db: ControllerDatabase;
let identity: ControllerIdentity;
let running: RunningControllerServer;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rbo-admin-'));
  db = openDatabase(':memory:');
  migrateToLatest(db);
  identity = await ensureControllerIdentity(dataDir);
  running = await startControllerServer({
    // These fixtures use local repos with no allowlisted remote, so overlay
    // capture is impossible; opt in to the full-snapshot path explicitly.
    allowFullSnapshotFallback: true,
    host: '127.0.0.1',
    port: 0,
    db,
    identity,
  });
});

afterAll(async () => {
  await running.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface AdminApiBody {
  requests?: Array<{ display_name: string }>;
  agents?: Array<{ id: string }>;
  agent_id?: string;
  error?: { category: string };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: AdminApiBody }> {
  const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as AdminApiBody };
}

describe('Admin API for CLI (§33)', () => {
  it('lists pending pairing requests', async () => {
    const device = generateDeviceKeyPair();
    createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'admin-list-agent',
      hostname: 'host-a',
    });

    const res = await post('/internal/v1/admin/pairing/list', {});
    expect(res.status).toBe(200);
    expect((res.body.requests ?? []).some((r) => r.display_name === 'admin-list-agent')).toBe(true);
  });

  it('approves a pairing request and the agent becomes listed', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'admin-approve-agent',
      hostname: 'host-b',
    });

    const approve = await post('/internal/v1/admin/pairing/approve', {
      pairing_request_id: request.id,
    });
    expect(approve.status).toBe(200);
    expect(approve.body.agent_id).toMatch(/^agt_/);

    const list = await post('/internal/v1/admin/agents/list', {});
    expect((list.body.agents ?? []).some((a) => a.id === approve.body.agent_id)).toBe(true);
  });

  it('rejects a pairing request', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'admin-reject-agent',
      hostname: null,
    });
    const res = await post('/internal/v1/admin/pairing/reject', {
      pairing_request_id: request.id,
    });
    expect(res.status).toBe(200);
  });

  it('revokes an agent', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'admin-revoke-agent',
      hostname: null,
    });
    const approve = await post('/internal/v1/admin/pairing/approve', {
      pairing_request_id: request.id,
    });
    const revoke = await post('/internal/v1/admin/agents/revoke', {
      agent_id: approve.body.agent_id,
    });
    expect(revoke.status).toBe(200);

    const list = await post('/internal/v1/admin/agents/list', {});
    expect((list.body.agents ?? []).some((a) => a.id === approve.body.agent_id)).toBe(false);
  });

  it('returns 404 approving an unknown pairing request', async () => {
    const res = await post('/internal/v1/admin/pairing/approve', {
      pairing_request_id: 'pair_missing',
    });
    expect(res.status).toBe(400);
  });

  it('probing an offline agent reports agent_offline', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'admin-probe-agent',
      hostname: null,
    });
    const approve = await post('/internal/v1/admin/pairing/approve', {
      pairing_request_id: request.id,
    });
    const probe = await post('/internal/v1/admin/agents/probe', {
      agent_id: approve.body.agent_id,
    });
    expect(probe.status).toBe(409);
    expect(probe.body.error?.category).toBe('agent_lost');
  });
});
