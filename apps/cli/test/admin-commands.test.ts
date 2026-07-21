import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity, generateDeviceKeyPair } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startControllerServer } from '../../controller/src/http/server.js';
import type { RunningControllerServer } from '../../controller/src/http/server.js';
import { createPairingRequest } from '../../controller/src/security/pairing.js';
import { migrateToLatest, openDatabase } from '../../controller/src/storage/database.js';
import type { ControllerDatabase } from '../../controller/src/storage/database.js';
import {
  approveAgentRemote,
  listAgentsRemote,
  probeAgentRemote,
  revokeAgentRemote,
} from '../src/commands/agents.js';

let running: RunningControllerServer;
let db: ControllerDatabase;
let baseUrl: string;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rbo-cli-admin-'));
  db = openDatabase(':memory:');
  migrateToLatest(db);
  const identity = await ensureControllerIdentity(dataDir);
  running = await startControllerServer({ host: '127.0.0.1', port: 0, db, identity });
  baseUrl = `http://127.0.0.1:${running.port}`;
});

afterAll(async () => {
  await running.close();
});

describe('CLI agent admin commands (§33)', () => {
  it('rbo agents lists agents via the admin API', async () => {
    const result = await listAgentsRemote(baseUrl);
    expect(Array.isArray(result.agents)).toBe(true);
  });

  it('rbo agent approve approves a pending pairing request by ID', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'cli-approve-agent',
      hostname: null,
    });
    const result = await approveAgentRemote(baseUrl, request.id);
    expect(result.agent_id).toMatch(/^agt_/);
  });

  it('rbo agent revoke revokes by agent ID', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'cli-revoke-agent',
      hostname: null,
    });
    const approved = await approveAgentRemote(baseUrl, request.id);
    await expect(revokeAgentRemote(baseUrl, approved.agent_id)).resolves.toEqual({});
  });

  it('rbo agent probe reports agent_lost for a disconnected agent', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'cli-probe-agent',
      hostname: null,
    });
    const approved = await approveAgentRemote(baseUrl, request.id);
    await expect(probeAgentRemote(baseUrl, approved.agent_id)).rejects.toThrow(/agent_lost/i);
  });
});
