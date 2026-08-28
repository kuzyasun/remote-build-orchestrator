import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presentLogTail } from '@rbo/executor';
import { afterEach, describe, expect, it } from 'vitest';
import { readBoundedFileTail } from '../src/jobs/submit.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('job_wait bounded tail safety', () => {
  it.each([
    { kind: 'OSC', prefix: Buffer.from('\x1b]0;') },
    { kind: 'CSI', prefix: Buffer.from('\x1b[31;') },
  ])('fails closed when a $kind sequence precedes the bounded suffix', async ({ prefix }) => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-job-wait-tail-'));
    tempDirs.push(dir);
    const path = join(dir, 'stderr.log');
    const payload = Buffer.from('SECRET_TOKEN=fixture-secret\nERROR: sentinel\n');
    await writeFile(path, Buffer.concat([prefix, Buffer.alloc(20 * 1024, 0x61), payload]));

    const tail = await readBoundedFileTail(path, 16 * 1024);
    expect(tail.prefixComplete).toBe(false);
    const presented = presentLogTail([tail.data], [], {
      maxBytes: 16 * 1024,
      maxLines: 20,
      stderrPrefixComplete: tail.prefixComplete,
      stdoutPrefixComplete: true,
    });
    expect(presented.length).toBe(0);
    expect(presented.toString('utf8')).not.toContain('SECRET_TOKEN');
    expect(presented.toString('utf8')).not.toContain('\ufffd');
  });
});
