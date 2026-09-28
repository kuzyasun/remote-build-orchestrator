import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { createMockAgentCapability } from '@rbo/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { AgentConnection } from '../src/connection/client.js';

describe('connectOnce before hello_ack', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when mDNS refresh closes the socket during the handshake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-conn-drop-'));
    dirs.push(dir);
    const identity = await ensureControllerIdentity(dir);
    const https = createServer({ cert: identity.tlsCertPem, key: identity.tlsKeyPem });
    const wss = new WebSocketServer({ server: https, path: '/agent' });
    const opened = new Promise<void>((resolve) => {
      wss.on('connection', () => resolve());
    });
    await new Promise<void>((resolve) => {
      https.listen(0, '127.0.0.1', () => resolve());
    });
    const address = https.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP port');
    }

    const conn = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${address.port}/agent`,
      expectedFingerprint: identity.fingerprint,
      stateDir: dir,
      displayName: 'drop-test',
      capabilities: createMockAgentCapability({ display_name: 'drop-test' }),
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
    });
    const pending = conn.connectOnce();
    await opened;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relocated = `wss://192.168.0.20:${address.port}/agent`;
    conn.setControllerUrl(relocated);
    conn.dropIfOpenToOtherUrl(relocated);

    await expect(pending).rejects.toThrow(/closed before authentication/);

    conn.close();
    await new Promise<void>((resolve, reject) => {
      wss.close(() => {
        https.close((error) => (error ? reject(error) : resolve()));
      });
    });
  });

  it('rejects a dial that is still connecting when the controller address changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-conn-drop-'));
    dirs.push(dir);
    const identity = await ensureControllerIdentity(dir);
    const https = createServer({ cert: identity.tlsCertPem, key: identity.tlsKeyPem });
    const wss = new WebSocketServer({ server: https, path: '/agent' });
    await new Promise<void>((resolve) => {
      https.listen(0, '127.0.0.1', () => resolve());
    });
    const address = https.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP port');
    }

    const conn = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${address.port}/agent`,
      expectedFingerprint: identity.fingerprint,
      stateDir: dir,
      displayName: 'drop-test',
      capabilities: createMockAgentCapability({ display_name: 'drop-test' }),
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
    });
    const pending = conn.connectOnce();
    const relocated = `wss://192.168.0.20:${address.port}/agent`;
    conn.setControllerUrl(relocated);
    conn.dropIfOpenToOtherUrl(relocated);

    await expect(pending).rejects.toThrow();

    conn.close();
    await new Promise<void>((resolve, reject) => {
      wss.close(() => {
        https.close((error) => (error ? reject(error) : resolve()));
      });
    });
  });
});
