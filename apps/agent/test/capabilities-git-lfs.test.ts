import { describe, expect, it } from 'vitest';
import { probeCapabilities } from '../src/capabilities/probe.js';

describe('probeCapabilities git-lfs advertisement (§11.15)', () => {
  it('does not crash and returns a tools map', async () => {
    const caps = await probeCapabilities({
      agentId: 'agt_live',
      displayName: 'live',
      maxJobs: 1,
    });
    expect(caps.tools).toBeTypeOf('object');
    if (caps.tools['git-lfs']) {
      expect(caps.tools['git-lfs'].length).toBeGreaterThan(0);
    }
  });

  it('reports cpu_speed_mhz for host-aware scheduling capacity scoring', async () => {
    const caps = await probeCapabilities({
      agentId: 'agt_live',
      displayName: 'live',
      maxJobs: 1,
    });
    expect(caps.resources.cpu_speed_mhz).toBeTypeOf('number');
    expect(caps.resources.cpu_speed_mhz).toBeGreaterThanOrEqual(0);
  });
});
