import type { NetworkInterfaceInfo } from 'node:os';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControllerAdvertiser, MDNS_INTERFACE_WATCH_MS } from '../advertiser.js';

const mdnsMock = vi.hoisted(() => {
  return {
    holdTeardown: false,
    unpublishCalls: 0,
    pendingTeardown: null as null | (() => void),
    instances: [] as Array<{
      opts: { interface?: string } | undefined;
      emit: (event: string, err: NodeJS.ErrnoException) => boolean;
      listenerCount: (event: string) => number;
    }>,
  };
});

vi.mock('bonjour-service', () => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  class Bonjour {
    publish = vi.fn();
    unpublishAll = vi.fn((cb?: () => void) => {
      mdnsMock.unpublishCalls += 1;
      if (mdnsMock.holdTeardown) {
        mdnsMock.pendingTeardown = () => {
          cb?.();
        };
        return;
      }
      cb?.();
    });
    destroy = vi.fn((cb?: () => void) => {
      cb?.();
    });
    server: { mdns: InstanceType<typeof EventEmitter> };
    constructor(opts?: { interface?: string }) {
      this.server = { mdns: new EventEmitter() };
      mdnsMock.instances.push({
        opts,
        emit: (event, err) => this.server.mdns.emit(event, err),
        listenerCount: (event) => this.server.mdns.listenerCount(event),
      });
    }
  }
  return { Bonjour };
});

function nic(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('ControllerAdvertiser rebind', () => {
  let advertiser: ControllerAdvertiser;

  beforeEach(() => {
    advertiser = new ControllerAdvertiser();
  });

  afterEach(async () => {
    mdnsMock.holdTeardown = false;
    mdnsMock.unpublishCalls = 0;
    mdnsMock.pendingTeardown?.();
    mdnsMock.pendingTeardown = null;
    await advertiser.stop();
    mdnsMock.instances.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('binds the current LAN address instead of a stale requested IP and rebinds when it moves', async () => {
    vi.useFakeTimers();
    const interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      'Wi-Fi': [nic('192.168.0.105')],
    });
    const binds: string[] = [];
    advertiser.start({
      port: 7411,
      controllerId: 'controller_rebind',
      fingerprint: 'sha256:abc',
      interface: '192.168.0.102',
      onBind: (info) => {
        binds.push(info.interface ?? 'auto');
      },
    });

    expect(mdnsMock.instances).toHaveLength(1);
    expect(mdnsMock.instances[0]?.opts).toEqual({ interface: '192.168.0.105' });
    expect(binds).toEqual(['192.168.0.105']);

    interfaces.mockReturnValue({ 'Wi-Fi': [nic('192.168.0.110')] });
    await vi.advanceTimersByTimeAsync(MDNS_INTERFACE_WATCH_MS);
    await vi.advanceTimersByTimeAsync(500);

    expect(mdnsMock.instances).toHaveLength(2);
    expect(mdnsMock.instances[1]?.opts).toEqual({ interface: '192.168.0.110' });
    expect(binds).toEqual(['192.168.0.105', '192.168.0.110']);
  });

  it('rebinds after EADDRNOTAVAIL and ignores unrelated socket errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      'Wi-Fi': [nic('192.168.0.105')],
    });
    advertiser.start({
      port: 7411,
      controllerId: 'controller_rebind',
      fingerprint: 'sha256:abc',
    });
    expect(mdnsMock.instances).toHaveLength(1);

    const busy = Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
    mdnsMock.instances[0]?.emit('error', busy);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mdnsMock.instances).toHaveLength(1);

    const lost = Object.assign(new Error('addMembership'), { code: 'EADDRNOTAVAIL' });
    expect(mdnsMock.instances[0]?.listenerCount('warning')).toBeGreaterThan(0);
    expect(mdnsMock.instances[0]?.emit('warning', lost)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(mdnsMock.instances).toHaveLength(2);
    expect(mdnsMock.instances[1]?.opts).toEqual({ interface: '192.168.0.105' });
  });

  it('does not publish a second socket while a rebind teardown is still in flight', async () => {
    vi.useFakeTimers();
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      'Wi-Fi': [nic('192.168.0.105')],
    });
    advertiser.start({
      port: 7411,
      controllerId: 'controller_rebind',
      fingerprint: 'sha256:abc',
    });
    expect(mdnsMock.instances).toHaveLength(1);
    mdnsMock.holdTeardown = true;
    const lost = Object.assign(new Error('addMembership'), { code: 'EADDRNOTAVAIL' });
    mdnsMock.instances[0]?.emit('warning', lost);
    await vi.advanceTimersByTimeAsync(500);
    expect(mdnsMock.unpublishCalls).toBeGreaterThan(0);
    expect(mdnsMock.pendingTeardown).toBeTypeOf('function');
    expect(mdnsMock.instances).toHaveLength(1);

    mdnsMock.instances[0]?.emit('warning', lost);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mdnsMock.instances).toHaveLength(1);

    mdnsMock.holdTeardown = false;
    mdnsMock.pendingTeardown?.();
    mdnsMock.pendingTeardown = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(mdnsMock.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(MDNS_INTERFACE_WATCH_MS + 500);
    expect(mdnsMock.instances).toHaveLength(2);
  });
});
