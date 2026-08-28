import { describe, expect, it } from 'vitest';
import {
  formatProcessIdentity,
  parseProcessIdentity,
  processIdentityFromPid,
  processStartTimeMs,
} from '../src/process-identity.js';

describe('process identity', () => {
  it('format and parse round-trip', () => {
    const identity = formatProcessIdentity(4242, 1_700_000_000_000);
    expect(identity).toBe('pid:4242:start:1700000000000');
    expect(parseProcessIdentity(identity)).toEqual({ pid: 4242, startMs: 1_700_000_000_000 });
  });

  it('rejects legacy pid-only format', () => {
    expect(parseProcessIdentity('pid:4242')).toBeNull();
    expect(parseProcessIdentity('pid:4242:started:2026-07-20T00:00:00.000Z')).toBeNull();
  });

  it('reads start time for the current process', () => {
    const startMs = processStartTimeMs(process.pid);
    expect(startMs).not.toBeNull();
    if (startMs === null) {
      return;
    }
    expect(startMs).toBeLessThanOrEqual(Date.now());
    expect(processStartTimeMs(process.pid)).toBe(startMs);

    const identity = processIdentityFromPid(process.pid);
    expect(identity).toBe(`pid:${process.pid}:start:${startMs}`);
    expect(parseProcessIdentity(identity ?? '')).toEqual({
      pid: process.pid,
      startMs,
    });
  });
});
