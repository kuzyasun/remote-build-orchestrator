import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// selfsigned is CJS; default import via esModuleInterop.
import selfsigned from 'selfsigned';
import { ulid } from 'ulid';
import { certificateFingerprint } from './crypto.js';
import { generateDeviceKeyPair } from './crypto.js';
import { type RboLayoutOptions, resolveControllerDataDir } from './layout.js';

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
  adminToken: string;
  mcpToken: string;
}

const ADMIN_BEARER_SCOPE_VERSION = 2;

interface ControllerIdentityMetadata {
  controller_id: string;
  admin_bearer_scope_version?: number;
}

function pemToDer(certPem: string): Buffer {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

function ensureBearerToken(securityDir: string, name: 'admin-token' | 'mcp-token'): string {
  const path = join(securityDir, name);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!token) throw new Error(`Controller bearer token file is empty: ${path}`);
  return token;
}

function replacePrivateFile(path: string, content: string): void {
  const candidate = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(candidate, content, { mode: 0o600, flag: 'wx' });
    renameSync(candidate, path);
  } finally {
    rmSync(candidate, { force: true });
  }
}

export async function ensureControllerIdentity(
  dataDir: string,
  options: { rotateLegacyAdminBearer?: boolean } = {},
): Promise<ControllerIdentity> {
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
        admin_bearer_scope_version: ADMIN_BEARER_SCOPE_VERSION,
      }),
      { mode: 0o600 },
    );
  }

  const tlsCertPem = readFileSync(certPath, 'utf8');
  const signingPrivateKeyPem = readFileSync(signingPrivatePath, 'utf8');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ControllerIdentityMetadata;

  if (options.rotateLegacyAdminBearer && meta.admin_bearer_scope_version === undefined) {
    // Older HTTP MCP clients may know the original admin bearer. Derive the same
    // new secret on retry if startup is interrupted between the two file writes.
    const replacement = createHmac('sha256', signingPrivateKeyPem)
      .update('rbo/admin-bearer-scope/v2')
      .digest('hex');
    replacePrivateFile(join(securityDir, 'admin-token'), `${replacement}\n`);
    replacePrivateFile(
      metaPath,
      JSON.stringify({ ...meta, admin_bearer_scope_version: ADMIN_BEARER_SCOPE_VERSION }),
    );
  }
  const adminToken = ensureBearerToken(securityDir, 'admin-token');
  const mcpToken = ensureBearerToken(securityDir, 'mcp-token');

  return {
    controllerId: meta.controller_id,
    tlsCertPem,
    tlsKeyPem: readFileSync(keyPath, 'utf8'),
    signingPublicKeyPem: readFileSync(signingPublicPath, 'utf8'),
    signingPrivateKeyPem,
    fingerprint: certificateFingerprint(pemToDer(tlsCertPem)),
    adminToken: process.env.RBO_ADMIN_TOKEN?.trim() || adminToken,
    mcpToken: process.env.RBO_MCP_TOKEN?.trim() || mcpToken,
  };
}

function readBearerToken(
  options: RboLayoutOptions | undefined,
  name: 'admin-token' | 'mcp-token',
  envKey: 'RBO_ADMIN_TOKEN' | 'RBO_MCP_TOKEN',
): string | undefined {
  const envToken = (options?.env ?? process.env)[envKey]?.trim();
  if (envToken) {
    return envToken;
  }
  const tokenPath = join(resolveControllerDataDir(options), 'security', name);
  if (existsSync(tokenPath)) {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function readAdminToken(options?: RboLayoutOptions): string | undefined {
  return readBearerToken(options, 'admin-token', 'RBO_ADMIN_TOKEN');
}

export function readMcpToken(options?: RboLayoutOptions): string | undefined {
  return readBearerToken(options, 'mcp-token', 'RBO_MCP_TOKEN');
}
