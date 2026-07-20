import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeyPair, publicKeyThumbprint, signEdDsaJwt } from '@rbo/shared';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { revokeAgent } from '../src/agents/registry.js';
import { issueAgentCredential, verifyAgentCredential } from '../src/security/credentials.js';
import {
  approvePairingRequest,
  claimApprovedPairing,
  createPairingRequest,
  getPairingRequest,
  rejectPairingRequest,
} from '../src/security/pairing.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-sec-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newDb() {
  const db = openDatabase(':memory:');
  migrateToLatest(db);
  return db;
}

describe('Controller identity bootstrap (§8.1, Phase 2)', () => {
  it('creates a TLS certificate, signing keys and a stable fingerprint', async () => {
    const dir = tempDir();
    const identity = await ensureControllerIdentity(dir);
    expect(identity.controllerId).toMatch(/^controller_/);
    expect(identity.tlsCertPem).toContain('CERTIFICATE');
    expect(identity.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const reloaded = await ensureControllerIdentity(dir);
    expect(reloaded.controllerId).toBe(identity.controllerId);
    expect(reloaded.fingerprint).toBe(identity.fingerprint);
  });
});

describe('Pairing lifecycle (§8.1, Phase 2)', () => {
  it('creates a pending pairing request with a one-time code', () => {
    const db = newDb();
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'mac-mini-build',
      hostname: 'mac.local',
    });
    expect(request.state).toBe('pending');
    expect(request.one_time_code).toMatch(/^\d{6}$/);
  });

  it('approve creates an agent bound to the device key and issues a credential once', async () => {
    const db = newDb();
    const identity = await ensureControllerIdentity(tempDir());
    const device = generateDeviceKeyPair();

    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'win-lab',
      hostname: 'lab-pc',
    });
    const approved = approvePairingRequest(db, identity, request.id);
    expect(approved.agentId).toMatch(/^agt_/);

    const claim = claimApprovedPairing(db, identity, device.publicKeyPem);
    expect(claim).not.toBeNull();
    expect(claim?.agentId).toBe(approved.agentId);
    expect(claim?.credential.split('.')).toHaveLength(3);

    // Credential is delivered once.
    expect(claimApprovedPairing(db, identity, device.publicKeyPem)).toBeNull();
  });

  it('rejecting a pairing request prevents claiming', async () => {
    const db = newDb();
    const identity = await ensureControllerIdentity(tempDir());
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'x',
      hostname: null,
    });
    rejectPairingRequest(db, request.id);
    expect(getPairingRequest(db, request.id)?.state).toBe('rejected');
    expect(claimApprovedPairing(db, identity, device.publicKeyPem)).toBeNull();
  });
});

describe('Agent credentials (§8.1, Phase 2)', () => {
  async function pairedAgent(db: ReturnType<typeof newDb>, dir: string) {
    const identity = await ensureControllerIdentity(dir);
    const device = generateDeviceKeyPair();
    const request = createPairingRequest(db, {
      devicePublicKeyPem: device.publicKeyPem,
      displayName: 'agent-a',
      hostname: null,
    });
    const { agentId } = approvePairingRequest(db, identity, request.id);
    const credential = issueAgentCredential(db, identity, agentId);
    return { identity, device, agentId, credential };
  }

  it('verifies a valid credential', async () => {
    const db = newDb();
    const { identity, agentId, credential } = await pairedAgent(db, tempDir());
    const verified = verifyAgentCredential(db, identity, credential);
    expect(verified?.agentId).toBe(agentId);
  });

  it('rejects an expired credential', async () => {
    const db = newDb();
    const { identity, device, agentId } = await pairedAgent(db, tempDir());
    const expired = signEdDsaJwt(identity.signingPrivateKeyPem, {
      sub: agentId,
      aud: identity.controllerId,
      device_thumbprint: publicKeyThumbprint(device.publicKeyPem),
      credential_version: 1,
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    expect(verifyAgentCredential(db, identity, expired)).toBeNull();
  });

  it('rejects a revoked agent credential', async () => {
    const db = newDb();
    const { identity, agentId, credential } = await pairedAgent(db, tempDir());
    revokeAgent(db, agentId);
    expect(verifyAgentCredential(db, identity, credential)).toBeNull();
  });

  it('rejects a credential after rotation bumps the credential version', async () => {
    const db = newDb();
    const { identity, agentId, credential } = await pairedAgent(db, tempDir());
    issueAgentCredential(db, identity, agentId); // rotation → version 2
    expect(verifyAgentCredential(db, identity, credential)).toBeNull();
  });

  it('rejects a forged credential for an unknown agent', async () => {
    const db = newDb();
    const { identity } = await pairedAgent(db, tempDir());
    const forged = signEdDsaJwt(identity.signingPrivateKeyPem, {
      sub: 'agt_01J1234567890ABCDEFGHJKMNP',
      aud: identity.controllerId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(verifyAgentCredential(db, identity, forged)).toBeNull();
  });
});
