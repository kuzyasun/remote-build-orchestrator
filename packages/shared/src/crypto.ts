import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from 'node:crypto';

// Ed25519 device identity and Controller-signed EdDSA JWT credentials (§8.1).

export interface DeviceKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signNonce(privateKeyPem: string, nonce: string): string {
  return cryptoSign(null, Buffer.from(nonce, 'utf8'), privateKeyPem).toString('base64url');
}

export function verifyNonceSignature(
  publicKeyPem: string,
  nonce: string,
  signatureBase64Url: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(nonce, 'utf8'),
      publicKeyPem,
      Buffer.from(signatureBase64Url, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function publicKeyThumbprint(publicKeyPem: string): string {
  return `sha256:${createHash('sha256').update(publicKeyPem.trim()).digest('hex')}`;
}

export function certificateFingerprint(der: Buffer): string {
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

// --- Minimal EdDSA JWT (compact serialization) ---

export interface JwtClaims {
  sub: string;
  aud: string;
  exp: number;
  iat?: number;
  device_thumbprint?: string;
  credential_version?: number;
  scopes?: string[];
  [key: string]: unknown;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signEdDsaJwt(privateKeyPem: string, claims: JwtClaims): string {
  const header = base64UrlJson({ alg: 'EdDSA', typ: 'JWT' });
  const payload = base64UrlJson({ iat: Math.floor(Date.now() / 1000), ...claims });
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign(null, Buffer.from(signingInput, 'utf8'), privateKeyPem).toString(
    'base64url',
  );
  return `${signingInput}.${signature}`;
}

export function verifyEdDsaJwt(publicKeyPem: string, token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      alg?: string;
    };
    if (parsedHeader.alg !== 'EdDSA') {
      return null;
    }
    const valid = cryptoVerify(
      null,
      Buffer.from(`${header}.${payload}`, 'utf8'),
      publicKeyPem,
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) {
      return null;
    }
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
