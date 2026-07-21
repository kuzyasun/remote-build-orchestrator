import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertPinnedPeerCert,
  controllerDataPlaneAgent,
  pinnedTlsRequestOptions,
} from '../src/executor/tls-pin.js';

/**
 * Regression: TLS 1.3 session resumption leaves getPeerCertificate() empty.
 * Second data-plane download must not fail pin with "did not present a TLS certificate".
 */
describe('tls-pin session resume', () => {
  let fingerprint: string;
  let port: number;
  let tempDir: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rbo-tls-pin-'));
    const identity = await ensureControllerIdentity(tempDir);
    fingerprint = identity.fingerprint;

    const server = createHttpsServer(
      { cert: identity.tlsCertPem, key: identity.tlsKeyPem },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      },
    );

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('expected TCP address');
    }
    port = addr.port;
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
  });

  afterAll(async () => {
    controllerDataPlaneAgent.destroy();
    await closeServer();
    await rm(tempDir, { recursive: true, force: true });
  });

  function getOnce(): Promise<{
    pinError: Error | undefined;
    sessionReused: boolean;
    hasRaw: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        `https://127.0.0.1:${port}/`,
        {
          method: 'GET',
          ...pinnedTlsRequestOptions(fingerprint),
        },
        (res) => {
          const socket = res.socket as {
            isSessionReused?: () => boolean;
            getPeerCertificate?: (d?: boolean) => { raw?: Buffer };
          };
          const cert = socket.getPeerCertificate?.(true);
          const pinError = assertPinnedPeerCert(res, fingerprint);
          res.resume();
          resolve({
            pinError,
            sessionReused: Boolean(socket.isSessionReused?.()),
            hasRaw: Boolean(cert?.raw),
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('accepts TLS session resume when peer cert DER is unavailable', () => {
    const res = {
      socket: {
        isSessionReused: () => true,
        getPeerCertificate: () => ({}),
        getX509Certificate: () => undefined,
      },
    } as unknown as import('node:http').IncomingMessage;
    expect(assertPinnedPeerCert(res, fingerprint)).toBeUndefined();
  });

  it('pins the first full handshake and accepts a resumed TLS session', async () => {
    const first = await getOnce();
    expect(first.pinError).toBeUndefined();
    expect(first.sessionReused).toBe(false);
    expect(first.hasRaw).toBe(true);

    const second = await getOnce();
    expect(second.pinError).toBeUndefined();
    // On TLS 1.3 resume Node often returns an empty peer cert object.
    if (second.sessionReused) {
      expect(second.hasRaw).toBe(false);
    }
  });

  it('rejects a fingerprint mismatch on a full handshake', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        `https://127.0.0.1:${port}/`,
        {
          method: 'GET',
          // Force a full handshake so mismatch is observable.
          agent: false,
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
        },
        (res) => {
          const pinError = assertPinnedPeerCert(res, `sha256:${'0'.repeat(64)}`);
          res.resume();
          try {
            expect(pinError?.message).toMatch(/fingerprint mismatch/);
            resolve();
          } catch (err) {
            reject(err);
          }
        },
      );
      req.on('error', reject);
      req.end();
    });
  });
});
