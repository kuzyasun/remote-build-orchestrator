import { describe, expect, it } from 'vitest';
import { hostLookupCandidates, isRoutableIpAddress, normalizeMdnsHost } from '../address.js';
import { type DiscoveredController, chooseDiscoveredController } from '../browser.js';

function controller(partial: Partial<DiscoveredController>): DiscoveredController {
  return {
    name: 'rbo-controller',
    host: 'KPC',
    addresses: [],
    port: 7411,
    controllerId: 'controller_1',
    fingerprint: 'sha256:abc',
    version: '1',
    ...partial,
  };
}

describe('mDNS address selection', () => {
  it('turns a bare computer name into a .local lookup', () => {
    expect(normalizeMdnsHost('KPC')).toBe('KPC.local');
    expect(normalizeMdnsHost('KPC.local.')).toBe('KPC.local');
    expect(normalizeMdnsHost('192.168.1.9')).toBe('192.168.1.9');
    expect(hostLookupCandidates('KPC')).toEqual(['KPC', 'KPC.local']);
    expect(hostLookupCandidates('KPC.local')).toEqual(['KPC.local']);
  });

  it('does not treat a hostname as a routable IP', () => {
    expect(isRoutableIpAddress('KPC')).toBe(false);
    expect(isRoutableIpAddress('192.168.1.9')).toBe(true);
    expect(isRoutableIpAddress('127.0.0.1')).toBe(false);
  });

  it('replaces a hostname-only discovery with a later record that has an IP', () => {
    const first = controller({ host: 'KPC', addresses: [] });
    const second = controller({
      host: 'KPC.local',
      addresses: ['192.168.1.9'],
      responderAddress: '192.168.1.9',
    });
    expect(chooseDiscoveredController(first, second).addresses).toEqual(['192.168.1.9']);
    expect(chooseDiscoveredController(second, first).addresses).toEqual(['192.168.1.9']);
  });

  it('prefers a record with a LAN address over one that only has 0.0.0.0', () => {
    const unspecified = controller({
      host: 'KPC',
      addresses: ['0.0.0.0'],
      responderAddress: '0.0.0.0',
    });
    const lan = controller({
      host: 'KPC.local',
      addresses: ['192.168.0.102'],
      responderAddress: '192.168.0.102',
    });
    expect(chooseDiscoveredController(unspecified, lan).addresses).toEqual(['192.168.0.102']);
  });
});
