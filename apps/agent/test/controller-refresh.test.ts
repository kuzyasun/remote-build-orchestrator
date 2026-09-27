import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredController } from '@rbo/discovery';
import { afterEach, describe, expect, it } from 'vitest';
import { persistAgentControllerUrl, writeDefaultAgentConfigFile } from '../src/config.js';
import {
  discoverRelocatedControllerUrl,
  relocatedControllerUrl,
} from '../src/controller-refresh.js';

const fingerprint = 'sha256:abc';
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-agent-mdns-'));
  tempDirs.push(dir);
  return dir;
}

function controller(partial: Partial<DiscoveredController>): DiscoveredController {
  return {
    name: 'rbo-controller',
    host: 'KPC',
    addresses: ['192.168.0.20'],
    port: 7411,
    controllerId: 'ctl_1',
    fingerprint,
    version: '1',
    responderAddress: '192.168.0.20',
    ...partial,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('relocatedControllerUrl', () => {
  it('returns the new routable address for the pinned fingerprint', () => {
    const next = relocatedControllerUrl('wss://192.168.0.102:7411/agent', fingerprint, [
      controller({}),
    ]);
    expect(next).toBe('wss://192.168.0.20:7411/agent');
  });

  it('ignores a different controller and a hostname-only advertisement', () => {
    expect(
      relocatedControllerUrl('wss://192.168.0.102:7411/agent', fingerprint, [
        controller({
          fingerprint: 'sha256:other',
          addresses: ['10.0.0.5'],
          responderAddress: '10.0.0.5',
        }),
      ]),
    ).toBeUndefined();
    expect(
      relocatedControllerUrl('wss://192.168.0.102:7411/agent', fingerprint, [
        controller({ addresses: [], responderAddress: undefined, host: 'KPC' }),
      ]),
    ).toBeUndefined();
  });

  it('leaves the URL unchanged when mDNS still shows the same address', () => {
    expect(
      relocatedControllerUrl('wss://192.168.0.20:7411/agent', fingerprint, [controller({})]),
    ).toBeUndefined();
  });

  it('keeps the current address when another interface is the mDNS responder', () => {
    expect(
      relocatedControllerUrl('wss://192.168.0.20:7411/agent', fingerprint, [
        controller({
          addresses: ['192.168.0.20', '10.1.0.8'],
          responderAddress: '10.1.0.8',
        }),
      ]),
    ).toBeUndefined();
  });

  it('follows a port change on an address that is still advertised', () => {
    expect(
      relocatedControllerUrl('wss://192.168.0.20:7411/agent', fingerprint, [
        controller({ port: 7412 }),
      ]),
    ).toBe('wss://192.168.0.20:7412/agent');
  });
});

describe('discoverRelocatedControllerUrl', () => {
  it('uses the injected browse result and survives a browse failure', async () => {
    const found = await discoverRelocatedControllerUrl({
      currentUrl: 'wss://192.168.0.102:7411/agent',
      fingerprint,
      discover: async () => [controller({})],
    });
    expect(found).toBe('wss://192.168.0.20:7411/agent');

    const missed = await discoverRelocatedControllerUrl({
      currentUrl: 'wss://192.168.0.102:7411/agent',
      fingerprint,
      discover: async () => {
        throw new Error('mdns down');
      },
    });
    expect(missed).toBeUndefined();
  });
});

describe('persistAgentControllerUrl', () => {
  it('updates controller_url and keeps the fingerprint and other fields', () => {
    const dir = tempDir();
    writeDefaultAgentConfigFile(dir, {
      discovery: {
        controllerUrl: 'wss://192.168.0.102:7411/agent',
        controllerFingerprint: fingerprint,
      },
    });
    expect(persistAgentControllerUrl(dir, 'wss://192.168.0.20:7411/agent')).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as {
      controller_url: string;
      controller_fingerprint: string;
      display_name: string;
    };
    expect(saved.controller_url).toBe('wss://192.168.0.20:7411/agent');
    expect(saved.controller_fingerprint).toBe(fingerprint);
    expect(saved.display_name).toBe('rbo-agent');
    expect(persistAgentControllerUrl(dir, 'wss://192.168.0.20:7411/agent')).toBe(false);
  });
});
