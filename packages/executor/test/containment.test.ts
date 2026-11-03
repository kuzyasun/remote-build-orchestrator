import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createLinuxCgroupScope,
  findAttemptPids,
  parseDarwinPsOutput,
} from '../src/containment.js';

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

  it('parseDarwinPsOutput correctly parses streaming ps lines and ignores self pid', async () => {
    const lines = [
      '  100 /bin/bash RBO_CONTAINMENT_ID=att_123 PATH=/bin',
      '  200 /bin/zsh RBO_ATTEMPT_ID=att_123 PATH=/bin',
      '  300 /bin/zsh OTHER_VAR=value',
      '  400 /bin/sleep 100 RBO_CONTAINMENT_ID=att_123',
    ];
    const stream = Readable.from(lines.join('\n'));
    const pids = await parseDarwinPsOutput(stream, 'att_123', 200);
    expect(pids).toEqual([100, 400]);
  });

  it('parseDarwinPsOutput handles process streams larger than 1 MiB without error', async () => {
    // Generate ~2 MiB of process table lines
    async function* generateLines() {
      const filler = 'X'.repeat(200);
      for (let i = 1; i <= 10000; i++) {
        if (i === 42) {
          yield `42 /app/worker RBO_CONTAINMENT_ID=target_stream_job ${filler}\n`;
        } else {
          yield `${i + 1000} /usr/bin/daemon ${filler}\n`;
        }
      }
    }
    const stream = Readable.from(generateLines());
    const pids = await parseDarwinPsOutput(stream, 'target_stream_job', 999999);
    expect(pids).toEqual([42]);
  });
});
