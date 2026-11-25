import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinnedTlsRequestOptions } from '../src/executor/tls-pin.js';

describe('Controller data-plane TLS pin', () => {
  let fingerprint: string;
  let port: number;
  let tempDir: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rbo-tls-pin-'));
    const identity = await ensureControllerIdentity(tempDir);
    fingerprint = identity.fingerprint;

    const server = createServer(
      { cert: identity.tlsCertPem, key: identity.tlsKeyPem },
      (_req, res) => res.end('ok'),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
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
    await closeServer?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  function getOnce(): Promise<{ status: number | undefined; sessionReused: boolean }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `https://127.0.0.1:${port}/`,
        pinnedTlsRequestOptions(fingerprint),
        (res) => {
          const socket = res.socket as TLSSocket;
          res.resume();
          res.once('end', () =>
            resolve({ status: res.statusCode, sessionReused: socket.isSessionReused() }),
          );
        },
      );
      req.once('error', reject);
      req.end();
    });
  }

  it('checks a fresh TLS handshake on successive data-plane requests', async () => {
    expect(await getOnce()).toEqual({ status: 200, sessionReused: false });
    expect(await getOnce()).toEqual({ status: 200, sessionReused: false });
  });

  it('never hands a socket with an unknown certificate to HTTP', async () => {
    const { createConnection } = pinnedTlsRequestOptions(`sha256:${'0'.repeat(64)}`);
    expect(createConnection).toBeTypeOf('function');
    await new Promise<void>((resolve, reject) => {
      const returned = createConnection?.({ host: '127.0.0.1', port }, (error, socket) => {
        try {
          expect(error?.message).toMatch(/fingerprint mismatch/);
          expect(socket.destroyed).toBe(true);
          resolve();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
      // Node would attach any synchronously returned socket before TLS completes.
      expect(returned).toBeUndefined();
    });
  });
});
