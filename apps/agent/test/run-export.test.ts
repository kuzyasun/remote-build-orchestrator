import { describe, expect, it } from 'vitest';

describe('agent run export', () => {
  it('exports runAgent', async () => {
    const mod = await import('../src/run.js');
    expect(typeof mod.runAgent).toBe('function');
  });
});
