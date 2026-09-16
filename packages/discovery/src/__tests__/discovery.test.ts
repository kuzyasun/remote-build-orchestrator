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

  it('advertiser.start validates displayName and rejects invalid values', () => {
    const fresh = new ControllerAdvertiser();
    expect(() =>
      fresh.start({
        port: 17414,
        controllerId: 'c1',
        fingerprint: 'f1',
        displayName: 'a'.repeat(64),
      }),
    ).toThrow(/exceeds 63 bytes/);

    expect(() =>
      fresh.start({
        port: 17414,
        controllerId: 'c1',
        fingerprint: 'f1',
        displayName: 'bad\nname',
      }),
    ).toThrow(/control characters/);

    expect(() =>
      fresh.start({
        port: 17414,
        controllerId: 'c1',
        fingerprint: 'f1',
        displayName: '   ',
      }),
    ).toThrow(/cannot be empty/);
  });

  it('stop is safe when not started and handles concurrent stops', async () => {
    const fresh = new ControllerAdvertiser();
    await expect(fresh.stop()).resolves.toBeUndefined();
    await expect(Promise.all([fresh.stop(), fresh.stop()])).resolves.toBeDefined();
  });
});

describe('validateMdnsDisplayName', () => {
  it('accepts valid DNS-SD service instance names', async () => {
    const { validateMdnsDisplayName } = await import('../advertiser.js');
    expect(validateMdnsDisplayName('rbo-controller')).toBe('rbo-controller');
    expect(validateMdnsDisplayName('  my-ctrl-123  ')).toBe('my-ctrl-123');
    expect(validateMdnsDisplayName('контролер')).toBe('контролер');
  });

  it('rejects empty or whitespace-only names', async () => {
    const { validateMdnsDisplayName } = await import('../advertiser.js');
    expect(() => validateMdnsDisplayName('')).toThrow(/cannot be empty/);
    expect(() => validateMdnsDisplayName('   ')).toThrow(/cannot be empty/);
  });

  it('rejects names exceeding 63 UTF-8 bytes (RFC 6763 §4.1.1)', async () => {
    const { validateMdnsDisplayName } = await import('../advertiser.js');
    expect(() => validateMdnsDisplayName('a'.repeat(64))).toThrow(/exceeds 63 bytes/);
    expect(() => validateMdnsDisplayName('я'.repeat(32))).toThrow(/exceeds 63 bytes/);
  });

  it('rejects names containing control characters', async () => {
    const { validateMdnsDisplayName } = await import('../advertiser.js');
    expect(() => validateMdnsDisplayName('ctrl\x00name')).toThrow(/control characters/);
    expect(() => validateMdnsDisplayName('ctrl\nname')).toThrow(/control characters/);
    expect(() => validateMdnsDisplayName('ctrl\x1b[31mname')).toThrow(/control characters/);
    expect(() => validateMdnsDisplayName('ctrl\x7fname')).toThrow(/control characters/);
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

  it('captures responderAddress from service.referer.address', async () => {
    const { serviceToController } = await import('../browser.js');
    const mockService = {
      name: 'ctrl-referer',
      host: 'referer.local',
      port: 7411,
      addresses: ['192.168.56.1', '10.0.0.25'],
      referer: { address: '10.0.0.25' },
      txt: {
        controller_id: 'controller_ref_123',
        fingerprint: 'sha256:ref123',
        version: '1',
      },
    };
    const ctrl = serviceToController(mockService as unknown as Service);
    expect(ctrl).not.toBeNull();
    expect(ctrl?.responderAddress).toBe('10.0.0.25');
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
      txt: { controller_id: 'c1', fingerprint: 'f1', version: '1' },
    };
    expect(serviceToController({ ...base, port: 0 } as unknown as Service)).toBeNull();
    expect(serviceToController({ ...base, port: -1 } as unknown as Service)).toBeNull();
    expect(serviceToController({ ...base, port: 70000 } as unknown as Service)).toBeNull();
    expect(
      serviceToController({ ...base, port: '7411' as unknown as number } as unknown as Service),
    ).toBeNull();
  });

  it('rejects services with missing or unsupported protocol versions', async () => {
    const { serviceToController } = await import('../browser.js');
    const base = {
      name: 'test-ver',
      host: 'test.local',
      port: 7411,
      txt: { controller_id: 'c1', fingerprint: 'f1' },
    };
    // Missing version
    expect(serviceToController(base as unknown as Service)).toBeNull();
    // Unsupported future version
    expect(
      serviceToController({
        ...base,
        txt: { ...base.txt, version: '2' },
      } as unknown as Service),
    ).toBeNull();
    // Empty version
    expect(
      serviceToController({
        ...base,
        txt: { ...base.txt, version: '' },
      } as unknown as Service),
    ).toBeNull();
    // Valid version
    expect(
      serviceToController({
        ...base,
        txt: { ...base.txt, version: '1' },
      } as unknown as Service),
    ).not.toBeNull();
  });

  it('rejects services containing control characters in identity, fingerprint, name, or host', async () => {
    const { serviceToController } = await import('../browser.js');
    const validBase = {
      name: 'ctrl-valid',
      host: 'valid.local',
      port: 7411,
      addresses: ['192.168.1.50'],
      txt: { controller_id: 'controller_123', fingerprint: 'sha256:abc', version: '1' },
    };

    // Control character / ANSI injection in controller_id
    expect(
      serviceToController({
        ...validBase,
        txt: { ...validBase.txt, controller_id: 'ctrl\x1b[31minjection\x1b[0m' },
      } as unknown as Service),
    ).toBeNull();
    expect(
      serviceToController({
        ...validBase,
        txt: { ...validBase.txt, controller_id: 'ctrl\ninjection' },
      } as unknown as Service),
    ).toBeNull();

    // Control character in fingerprint
    expect(
      serviceToController({
        ...validBase,
        txt: { ...validBase.txt, fingerprint: 'sha256:abc\r\n' },
      } as unknown as Service),
    ).toBeNull();

    // Control character in service name
    expect(
      serviceToController({
        ...validBase,
        name: 'ctrl\x00evil',
      } as unknown as Service),
    ).toBeNull();

    // Control character in service host
    expect(
      serviceToController({
        ...validBase,
        host: 'host\x7fevil.local',
      } as unknown as Service),
    ).toBeNull();

    // Malicious entries in addresses are filtered out
    const withBadAddresses = serviceToController({
      ...validBase,
      addresses: ['192.168.1.50', 'bad\x1b[2Kaddress', '10.0.0.1'],
    } as unknown as Service);
    expect(withBadAddresses).not.toBeNull();
    expect(withBadAddresses?.addresses).toEqual(['192.168.1.50', '10.0.0.1']);
  });
});
