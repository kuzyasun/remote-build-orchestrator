import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// selfsigned is CJS; default import via esModuleInterop.
import selfsigned from 'selfsigned';
import { ulid } from 'ulid';
import { certificateFingerprint } from './crypto.js';
import { generateDeviceKeyPair } from './crypto.js';

// Controller identity (§8.1): a pinned TLS certificate for port 7411 plus an
// Ed25519 signing key pair used to sign agent credentials and data tokens.
// Pure fs/crypto — no database dependency — so both the Controller process
// and `rbo controller init/fingerprint` can bootstrap/read it directly.

export interface ControllerIdentity {
  controllerId: string;
  tlsCertPem: string;
  tlsKeyPem: string;
  signingPublicKeyPem: string;
  signingPrivateKeyPem: string;
  fingerprint: string;
}

function pemToDer(certPem: string): Buffer {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

export async function ensureControllerIdentity(dataDir: string): Promise<ControllerIdentity> {
  const securityDir = join(dataDir, 'security');
  mkdirSync(securityDir, { recursive: true });

  const certPath = join(securityDir, 'controller-cert.pem');
  const keyPath = join(securityDir, 'controller-key.pem');
  const signingPublicPath = join(securityDir, 'signing-public.pem');
  const signingPrivatePath = join(securityDir, 'signing-private.pem');
  const metaPath = join(securityDir, 'controller.json');

  if (!existsSync(certPath)) {
    const generated = await selfsigned.generate([{ name: 'commonName', value: 'rbo-controller' }], {
      notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
      keySize: 2048,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    });
    const signing = generateDeviceKeyPair();
    writeFileSync(certPath, generated.cert, { mode: 0o600 });
    writeFileSync(keyPath, generated.private, { mode: 0o600 });
    writeFileSync(signingPublicPath, signing.publicKeyPem, { mode: 0o600 });
    writeFileSync(signingPrivatePath, signing.privateKeyPem, { mode: 0o600 });
    writeFileSync(
      metaPath,
      JSON.stringify({
        controller_id: `controller_${ulid()}`,
        created_at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }

  const tlsCertPem = readFileSync(certPath, 'utf8');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { controller_id: string };

  return {
    controllerId: meta.controller_id,
    tlsCertPem,
    tlsKeyPem: readFileSync(keyPath, 'utf8'),
    signingPublicKeyPem: readFileSync(signingPublicPath, 'utf8'),
    signingPrivateKeyPem: readFileSync(signingPrivatePath, 'utf8'),
    fingerprint: certificateFingerprint(pemToDer(tlsCertPem)),
  };
}
