import { describe, expect, it } from 'vitest';
import {
  createDiscoveredControllerFromDnsSd,
  parseDnsSdBrowseLine,
  parseDnsSdGetAddrInfoLine,
  parseDnsSdResolveOutput,
} from '../dnssd.js';

describe('parseDnsSdBrowseLine', () => {
  it('parses a standard Add line from dns-sd -B', () => {
    const line =
      '23:18:17.580  Add        2  15 local.               _rbo-controller._tcp. rbo-controller';
    const result = parseDnsSdBrowseLine(line);
    expect(result).toEqual({
      domain: 'local.',
      serviceType: '_rbo-controller._tcp.',
      instanceName: 'rbo-controller',
    });
  });

  it('parses instance names with whitespace', () => {
    const line =
      '23:18:17.580  Add        2  15 local.               _rbo-controller._tcp. My Office Mac Controller';
    const result = parseDnsSdBrowseLine(line);
    expect(result).toEqual({
      domain: 'local.',
      serviceType: '_rbo-controller._tcp.',
      instanceName: 'My Office Mac Controller',
    });
  });

  it('parses instance names with unicode characters', () => {
    const line =
      '23:18:17.580  Add        2  15 local.               _rbo-controller._tcp. Контролер Студії';
    const result = parseDnsSdBrowseLine(line);
    expect(result).toEqual({
      domain: 'local.',
      serviceType: '_rbo-controller._tcp.',
      instanceName: 'Контролер Студії',
    });
  });

  it('ignores Rmv (removal) lines', () => {
    const line =
      '23:18:17.580  Rmv        0  15 local.               _rbo-controller._tcp. rbo-controller';
    expect(parseDnsSdBrowseLine(line)).toBeNull();
  });

  it('ignores header and banner lines', () => {
    expect(parseDnsSdBrowseLine('Browsing for _rbo-controller._tcp')).toBeNull();
    expect(parseDnsSdBrowseLine('DATE: ---Thu 24 Sep 2026---')).toBeNull();
    expect(parseDnsSdBrowseLine('23:18:17.580  ...STARTING...')).toBeNull();
    expect(
      parseDnsSdBrowseLine(
        'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      ),
    ).toBeNull();
    expect(parseDnsSdBrowseLine('')).toBeNull();
    expect(parseDnsSdBrowseLine('   ')).toBeNull();
  });

  it('rejects instance names containing control characters', () => {
    const line =
      '23:18:17.580  Add        2  15 local.               _rbo-controller._tcp. ctrl\x1bname';
    expect(parseDnsSdBrowseLine(line)).toBeNull();
  });
});

describe('parseDnsSdResolveOutput', () => {
  it('parses standard resolve output with host, port, and TXT records', () => {
    const output = `
Lookup rbo-controller._rbo-controller._tcp.local.
DATE: ---Thu 24 Sep 2026---
23:18:17.580  ...STARTING...
23:18:17.580  rbo-controller._rbo-controller._tcp.local. can be reached at My-PC.local.:7411 (interface 15)
 version=1 tls=1 pairing=required controller_id=controller_01KY2FW4SPJ5BWC8EW0HPJ17KT fingerprint=sha256:a6a648dbd78cbe32caa663fb8ae8e189ece75183cbc60ad559ff44062f870098
`;
    const result = parseDnsSdResolveOutput(output);
    expect(result).not.toBeNull();
    expect(result?.host).toBe('My-PC.local');
    expect(result?.port).toBe(7411);
    expect(result?.txt.version).toBe('1');
    expect(result?.txt.tls).toBe('1');
    expect(result?.txt.pairing).toBe('required');
    expect(result?.txt.controller_id).toBe('controller_01KY2FW4SPJ5BWC8EW0HPJ17KT');
    expect(result?.txt.fingerprint).toBe(
      'sha256:a6a648dbd78cbe32caa663fb8ae8e189ece75183cbc60ad559ff44062f870098',
    );
  });

  it('handles multi-line TXT records', () => {
    const output = `
23:18:17.580  rbo-controller._rbo-controller._tcp.local. can be reached at build-host.local:8080 (interface 4)
 version=1
 controller_id=ctrl_12345
 fingerprint=sha256:deadbeef
`;
    const result = parseDnsSdResolveOutput(output);
    expect(result).not.toBeNull();
    expect(result?.host).toBe('build-host.local');
    expect(result?.port).toBe(8080);
    expect(result?.txt.version).toBe('1');
    expect(result?.txt.controller_id).toBe('ctrl_12345');
    expect(result?.txt.fingerprint).toBe('sha256:deadbeef');
  });

  it('returns null when can be reached at line is missing', () => {
    const output = `
Lookup rbo-controller._rbo-controller._tcp.local.
version=1 controller_id=ctrl_12345
`;
    expect(parseDnsSdResolveOutput(output)).toBeNull();
  });

  it('returns null when port is invalid or out of range', () => {
    const output1 = '23:18:17.580  svc can be reached at host.local:0 (interface 1)\nversion=1';
    expect(parseDnsSdResolveOutput(output1)).toBeNull();

    const output2 = '23:18:17.580  svc can be reached at host.local:70000 (interface 1)\nversion=1';
    expect(parseDnsSdResolveOutput(output2)).toBeNull();
  });
});

describe('parseDnsSdGetAddrInfoLine', () => {
  it('extracts IPv4 address from dns-sd -G v4 output line', () => {
    const line = '23:18:17.580  Add        2  15 My-PC.local.         192.168.0.102    120';
    expect(parseDnsSdGetAddrInfoLine(line)).toBe('192.168.0.102');
  });

  it('returns null for non-Add lines or header lines', () => {
    expect(
      parseDnsSdGetAddrInfoLine(
        'Timestamp     A/R Flags if Hostname             Address          TTL',
      ),
    ).toBeNull();
    expect(
      parseDnsSdGetAddrInfoLine(
        '23:18:17.580  Rmv        0  15 My-PC.local.         192.168.0.102    120',
      ),
    ).toBeNull();
    expect(parseDnsSdGetAddrInfoLine('')).toBeNull();
  });
});

describe('createDiscoveredControllerFromDnsSd', () => {
  it('creates valid DiscoveredController from resolved metadata', () => {
    const resolved = {
      host: 'my-pc.local',
      port: 7411,
      txt: {
        version: '1',
        controller_id: 'ctrl_001',
        fingerprint: 'sha256:112233',
      },
    };
    const ctrl = createDiscoveredControllerFromDnsSd('rbo-controller', resolved, ['192.168.0.102']);
    expect(ctrl).toEqual({
      name: 'rbo-controller',
      host: 'my-pc.local',
      addresses: ['192.168.0.102'],
      port: 7411,
      controllerId: 'ctrl_001',
      fingerprint: 'sha256:112233',
      version: '1',
      responderAddress: '192.168.0.102',
    });
  });

  it('does not use an unspecified address as the responder', () => {
    const resolved = {
      host: 'KPC',
      port: 7411,
      txt: {
        version: '1',
        controller_id: 'ctrl_001',
        fingerprint: 'sha256:112233',
      },
    };
    const ctrl = createDiscoveredControllerFromDnsSd('rbo-controller', resolved, [
      '0.0.0.0',
      '192.168.0.102',
    ]);
    expect(ctrl?.responderAddress).toBe('192.168.0.102');
  });

  it('rejects missing or wrong version', () => {
    const resolved = {
      host: 'my-pc.local',
      port: 7411,
      txt: {
        version: '99',
        controller_id: 'ctrl_001',
        fingerprint: 'sha256:112233',
      },
    };
    expect(
      createDiscoveredControllerFromDnsSd('rbo-controller', resolved, ['192.168.0.102']),
    ).toBeNull();
  });

  it('rejects missing controller_id or fingerprint', () => {
    const resolvedNoId = {
      host: 'my-pc.local',
      port: 7411,
      txt: {
        version: '1',
        fingerprint: 'sha256:112233',
      },
    };
    expect(
      createDiscoveredControllerFromDnsSd('rbo-controller', resolvedNoId, ['192.168.0.102']),
    ).toBeNull();

    const resolvedNoFp = {
      host: 'my-pc.local',
      port: 7411,
      txt: {
        version: '1',
        controller_id: 'ctrl_001',
      },
    };
    expect(
      createDiscoveredControllerFromDnsSd('rbo-controller', resolvedNoFp, ['192.168.0.102']),
    ).toBeNull();
  });

  it('rejects control characters in identity or fingerprint', () => {
    const resolved = {
      host: 'my-pc.local',
      port: 7411,
      txt: {
        version: '1',
        controller_id: 'ctrl\x00bad',
        fingerprint: 'sha256:112233',
      },
    };
    expect(
      createDiscoveredControllerFromDnsSd('rbo-controller', resolved, ['192.168.0.102']),
    ).toBeNull();
  });
});
