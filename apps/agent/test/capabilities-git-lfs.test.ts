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
});
