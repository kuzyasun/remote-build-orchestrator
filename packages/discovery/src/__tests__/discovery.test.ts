import { Bonjour, type Service } from 'bonjour-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControllerAdvertiser } from '../advertiser.js';
import { discoverControllers } from '../browser.js';

describe('mDNS discovery', () => {
  const advertiser = new ControllerAdvertiser();

  afterEach(async () => {
    await advertiser.stop();
  });

  it('discovers a published controller with correct TXT records', async () => {
    const opts = {
      port: 17411,
      controllerId: 'controller_test_001',
      fingerprint: 'sha256:aabbccdd',
      displayName: 'test-ctrl',
    };
    advertiser.start(opts);

    const results = await discoverControllers({ timeoutMs: 2_000 });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((r) => r.controllerId === opts.controllerId);
    expect(found).toBeDefined();
    expect(found?.port).toBe(17411);
    expect(found?.fingerprint).toBe('sha256:aabbccdd');
    expect(found?.version).toBe('1');
    expect(found?.name).toBe('test-ctrl');
  });

  it('returns empty when aborted via AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort();
    const results = await discoverControllers({ timeoutMs: 5000, signal: ac.signal });
    expect(results).toEqual([]);
  });

  it('handles multicast bind failure immediately without waiting for browse timeout', async () => {
    const findSpy = vi.spyOn(Bonjour.prototype, 'find').mockImplementation(() => {
      throw new Error('EADDRINUSE: bind failed');
    });
    try {
      const start = Date.now();
      const results = await discoverControllers({ timeoutMs: 5_000 });
      const elapsed = Date.now() - start;
      expect(results).toEqual([]);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      findSpy.mockRestore();
    }
  });

  it('deduplicates by controllerId', async () => {
    const opts = {
      port: 17412,
      controllerId: 'controller_dedup_001',
      fingerprint: 'sha256:dedup',
      displayName: 'dedup-ctrl',
    };
    advertiser.start(opts);

    const results = await discoverControllers({ timeoutMs: 2_000 });
    const matches = results.filter((r) => r.controllerId === opts.controllerId);
    expect(matches.length).toBe(1);
  });

  it('start is idempotent', () => {
    const opts = {
      port: 17413,
      controllerId: 'controller_idem_001',
      fingerprint: 'sha256:idem',
    };
    advertiser.start(opts);
    // Second call should not throw.
    advertiser.start(opts);
  });

  it('stop is safe when not started and handles concurrent stops', async () => {
    const fresh = new ControllerAdvertiser();
    await expect(fresh.stop()).resolves.toBeUndefined();
    await expect(Promise.all([fresh.stop(), fresh.stop()])).resolves.toBeDefined();
  });
});

describe('serviceToController and txtValue unit tests', () => {
  it('parses valid service correctly', async () => {
    const { serviceToController } = await import('../browser.js');
    const mockService = {
      name: 'ctrl-alpha',
      host: 'alpha.local',
      port: 7411,
      addresses: ['192.168.1.100'],
      txt: {
        controller_id: 'controller_valid_123',
        fingerprint: 'sha256:abc123def456',
        version: '1',
      },
    };
    const ctrl = serviceToController(mockService as unknown as Service);
    expect(ctrl).not.toBeNull();
    expect(ctrl?.controllerId).toBe('controller_valid_123');
    expect(ctrl?.fingerprint).toBe('sha256:abc123def456');
    expect(ctrl?.port).toBe(7411);
    expect(ctrl?.name).toBe('ctrl-alpha');
  });

  it('handles case-insensitive TXT keys and Buffer values (RFC 6763 §6.4)', async () => {
    const { serviceToController } = await import('../browser.js');
    const mockService = {
      name: 'ctrl-case',
      host: 'case.local',
      port: 7411,
      addresses: ['10.0.0.1'],
      txt: {
        CONTROLLER_ID: Buffer.from('controller_case_456'),
        FingerPrint: 'sha256:998877',
        VERSION: Buffer.from('1'),
      },
    };
    const ctrl = serviceToController(mockService as unknown as Service);
    expect(ctrl).not.toBeNull();
    expect(ctrl?.controllerId).toBe('controller_case_456');
    expect(ctrl?.fingerprint).toBe('sha256:998877');
    expect(ctrl?.version).toBe('1');
  });

  it('rejects services missing controller_id or fingerprint', async () => {
    const { serviceToController } = await import('../browser.js');
    expect(
      serviceToController({
        name: 'bad',
        host: 'bad.local',
        port: 7411,
        txt: { fingerprint: 'sha256:abc' },
      } as unknown as Service),
    ).toBeNull();

    expect(
      serviceToController({
        name: 'bad2',
        host: 'bad.local',
        port: 7411,
        txt: { controller_id: 'ctrl_1' },
      } as unknown as Service),
    ).toBeNull();
  });

  it('rejects services with invalid ports', async () => {
    const { serviceToController } = await import('../browser.js');
    const base = {
      name: 'test',
      host: 'test.local',
      txt: { controller_id: 'c1', fingerprint: 'f1' },
    };
    expect(serviceToController({ ...base, port: 0 } as unknown as Service)).toBeNull();
    expect(serviceToController({ ...base, port: -1 } as unknown as Service)).toBeNull();
    expect(serviceToController({ ...base, port: 70000 } as unknown as Service)).toBeNull();
    expect(
      serviceToController({ ...base, port: '7411' as unknown as number } as unknown as Service),
    ).toBeNull();
  });
});
