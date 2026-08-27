import { describe, expect, it } from 'vitest';
import {
  certificateFingerprint,
  generateDeviceKeyPair,
  signEdDsaJwt,
  signNonce,
  verifyEdDsaJwt,
  verifyNonceSignature,
} from '../src/crypto.js';

describe('Ed25519 device identity (§8.1)', () => {
  it('generates a key pair and signs/verifies a nonce', () => {
    const pair = generateDeviceKeyPair();
    expect(pair.publicKeyPem).toContain('PUBLIC KEY');
    expect(pair.privateKeyPem).toContain('PRIVATE KEY');

    const nonce = 'nonce-123';
    const signature = signNonce(pair.privateKeyPem, nonce);
    expect(verifyNonceSignature(pair.publicKeyPem, nonce, signature)).toBe(true);
    expect(verifyNonceSignature(pair.publicKeyPem, 'other-nonce', signature)).toBe(false);
  });

  it('rejects a signature from a different key (forged agent)', () => {
    const real = generateDeviceKeyPair();
    const forged = generateDeviceKeyPair();
    const signature = signNonce(forged.privateKeyPem, 'nonce-1');
    expect(verifyNonceSignature(real.publicKeyPem, 'nonce-1', signature)).toBe(false);
  });
});

describe('EdDSA JWT credentials (§8.1)', () => {
  it('issues and verifies a credential with required claims', () => {
    const controllerKeys = generateDeviceKeyPair();
    const token = signEdDsaJwt(controllerKeys.privateKeyPem, {
      sub: 'agt_01J1234567890ABCDEFGHJKMNP',
      aud: 'controller-1',
      device_thumbprint: 'sha256:abc',
      credential_version: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const claims = verifyEdDsaJwt(controllerKeys.publicKeyPem, token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('agt_01J1234567890ABCDEFGHJKMNP');
    expect(claims?.credential_version).toBe(1);
    expect(claims?.iat).toEqual(expect.any(Number));
  });

  it('can omit iat and typ for compact tokens', () => {
    const keys = generateDeviceKeyPair();
    const token = signEdDsaJwt(
      keys.privateKeyPem,
      { sub: 'c', aud: 'r', exp: Math.floor(Date.now() / 1000) + 3600 },
      { includeIat: false, header: { alg: 'EdDSA' } },
    );
    const claims = verifyEdDsaJwt(keys.publicKeyPem, token);
    expect(claims).toMatchObject({ sub: 'c', aud: 'r' });
    expect(claims?.iat).toBeUndefined();
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'EdDSA' });
  });

  it('rejects an expired credential', () => {
    const keys = generateDeviceKeyPair();
    const token = signEdDsaJwt(keys.privateKeyPem, {
      sub: 'agt_x',
      aud: 'controller-1',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    expect(verifyEdDsaJwt(keys.publicKeyPem, token)).toBeNull();
  });

  it('rejects a credential signed by another key', () => {
    const controllerKeys = generateDeviceKeyPair();
    const attackerKeys = generateDeviceKeyPair();
    const token = signEdDsaJwt(attackerKeys.privateKeyPem, {
      sub: 'agt_x',
      aud: 'controller-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(verifyEdDsaJwt(controllerKeys.publicKeyPem, token)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const keys = generateDeviceKeyPair();
    const token = signEdDsaJwt(keys.privateKeyPem, {
      sub: 'agt_x',
      aud: 'controller-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'agt_evil', aud: 'controller-1', exp: 9999999999 }),
    ).toString('base64url');
    expect(verifyEdDsaJwt(keys.publicKeyPem, `${header}.${forgedPayload}.${signature}`)).toBeNull();
  });
});

describe('Certificate fingerprint (§8.1)', () => {
  it('computes a stable sha256 fingerprint for DER bytes', () => {
    const der = Buffer.from('fake-der-bytes');
    const fp = certificateFingerprint(der);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(certificateFingerprint(der)).toBe(fp);
    expect(certificateFingerprint(Buffer.from('other'))).not.toBe(fp);
  });
});
