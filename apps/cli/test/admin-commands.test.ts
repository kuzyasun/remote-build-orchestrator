import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ensureControllerIdentity, generateDeviceKeyPair } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startControllerServer } from '../../controller/src/http/server.js';
import type { RunningControllerServer } from '../../controller/src/http/server.js';
import { createPairingRequest } from '../../controller/src/security/pairing.js';
import { migrateToLatest, openDatabase } from '../../controller/src/storage/database.js';
import type { ControllerDatabase } from '../../controller/src/storage/database.js';
import {
  approveAgentRemote,
  formatPendingPairingsList,
  listAgentsRemote,
  listPendingPairingsRemote,
  probeAgentRemote,
  promptPendingPairingSelection,
  rejectPairingRemote,
  revokeAgentRemote,
} from '../src/commands/agents.js';

let running: RunningControllerServer;
let db: ControllerDatabase;
let baseUrl: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rbo-cli-admin-'));
  db = openDatabase(':memory:');
  migrateToLatest(db);
  const identity = await ensureControllerIdentity(dataDir);
  running = await startControllerServer({ host: '127.0.0.1', port: 0, db, identity });
  baseUrl = `http://127.0.0.1:${running.port}`;
});

afterAll(async () => {
  await running.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI agent admin commands (§33)', () => {
  it('rbo agents lists registered agents and pending pairing requests', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'cli-pending-agent',
      hostname: 'host-a',
    });

    const result = await listAgentsRemote(baseUrl);

    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.pending_pairings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: request.id,
          display_name: 'cli-pending-agent',
          hostname: 'host-a',
          state: 'pending',
        }),
      ]),
    );
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

  it('rbo agent reject rejects a pending pairing request by ID', async () => {
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'cli-reject-agent',
      hostname: null,
    });
    await expect(rejectPairingRemote(baseUrl, request.id)).resolves.toEqual({});
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

  describe('interactive pairing selection', () => {
    it('formatPendingPairingsList formats empty list', () => {
      expect(formatPendingPairingsList([])).toBe('');
    });

    it('formatPendingPairingsList formats items with and without hostname', () => {
      const output = formatPendingPairingsList([
        {
          id: 'pair_01AAA',
          display_name: 'worker-linux',
          hostname: 'host-a',
          state: 'pending',
          one_time_code: '123456',
          expires_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'pair_02BBB',
          display_name: 'worker-mac',
          hostname: null,
          state: 'pending',
          one_time_code: '654321',
          expires_at: '2026-01-01T00:00:00Z',
        },
      ]);
      expect(output).toContain('1) worker-linux (hostname: host-a)');
      expect(output).toContain('ID: pair_01AAA  code: 123456');
      expect(output).toContain('2) worker-mac');
      expect(output).toContain('ID: pair_02BBB  code: 654321');
      expect(output).toContain('0) Cancel');
    });

    beforeAll(async () => {
      const prior = await listPendingPairingsRemote(baseUrl);
      for (const p of prior) {
        await approveAgentRemote(baseUrl, p.id);
      }
    });

    it('returns null when no pending requests exist', async () => {
      const result = await promptPendingPairingSelection(baseUrl, 'approve');
      expect(result).toBeNull();
    });

    it('returns null in non-interactive (non-TTY) environment when requests exist', async () => {
      const device = generateDeviceKeyPair();
      createPairingRequest(db, {
        devicePublicKeyPem: device.publicKeyPem,
        displayName: 'interactive-alpha',
        hostname: 'host-alpha',
      });
      const result = await promptPendingPairingSelection(baseUrl, 'approve', { isTTY: false });
      expect(result).toBeNull();
    });

    it('selects default request on Enter when single request exists', async () => {
      const input = Readable.from(['\n']);
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const result = await promptPendingPairingSelection(baseUrl, 'approve', {
        isTTY: true,
        input,
        output,
      });
      expect(result).not.toBeNull();
      expect(result?.display_name).toBe('interactive-alpha');
    });

    it('selects request interactively when operator enters option number', async () => {
      const device2 = generateDeviceKeyPair();
      createPairingRequest(db, {
        devicePublicKeyPem: device2.publicKeyPem,
        displayName: 'interactive-beta',
        hostname: 'host-beta',
      });
      const input = Readable.from(['2\n']);
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const result = await promptPendingPairingSelection(baseUrl, 'approve', {
        isTTY: true,
        input,
        output,
      });
      expect(result).not.toBeNull();
      expect(result?.display_name).toBe('interactive-beta');
    });

    it('returns null when operator selects 0 (Cancel)', async () => {
      const input = Readable.from(['0\n']);
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const result = await promptPendingPairingSelection(baseUrl, 'approve', {
        isTTY: true,
        input,
        output,
      });
      expect(result).toBeNull();
    });

    it('returns null when operator enters an invalid selection', async () => {
      const input = Readable.from(['99\n']);
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const result = await promptPendingPairingSelection(baseUrl, 'approve', {
        isTTY: true,
        input,
        output,
      });
      expect(result).toBeNull();
    });

    it('throws when selection is aborted via signal / SIGINT', async () => {
      const ac = new AbortController();
      ac.abort();
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      await expect(
        promptPendingPairingSelection(baseUrl, 'approve', {
          isTTY: true,
          output,
          signal: ac.signal,
        }),
      ).rejects.toThrow('Pairing approve cancelled by operator');
    });
  });
});
