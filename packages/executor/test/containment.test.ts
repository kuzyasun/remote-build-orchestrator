import { describe, expect, it } from 'vitest';
import { createLinuxCgroupScope, findAttemptPids } from '../src/containment.js';

describe('Process containment helpers (§15.2)', () => {
  it('findAttemptPids returns empty array when attemptId is empty', async () => {
    const pids = await findAttemptPids('');
    expect(pids).toEqual([]);
  });

  it('createLinuxCgroupScope returns null on non-linux platforms', async () => {
    if (process.platform !== 'linux') {
      const scope = await createLinuxCgroupScope('att_non_linux');
      expect(scope).toBeNull();
    }
  });

  it('findAttemptPids returns empty array when no processes match the attempt ID', async () => {
    const pids = await findAttemptPids('att_non_existent_unique_999999');
    expect(pids).toEqual([]);
  });
});
