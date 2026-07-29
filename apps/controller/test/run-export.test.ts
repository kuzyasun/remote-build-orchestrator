import { describe, expect, it } from 'vitest';

describe('controller run export', () => {
  it('exports runController', async () => {
    const mod = await import('../src/run.js');
    expect(typeof mod.runController).toBe('function');
  });
});
