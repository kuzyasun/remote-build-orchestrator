import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAttemptLogs, spawnJobScript, writeJobScript } from '../src/index.js';

describe('spawnJobScript onLogChunk', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('invokes onLogChunk instead of direct attachLogs when provided', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-on-log-chunk-'));
    const controlDir = join(dir, 'control');
    const projectPath = join(dir, 'project');
    await mkdir(controlDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    const logs = await ensureAttemptLogs(join(dir, 'logs'));

    const isWin = process.platform === 'win32';
    const execution = {
      script: 'echo HELLO_CHUNK',
      shell: isWin ? ('direct' as const) : ('bash' as const),
      timeout_seconds: 30,
      cancel_grace_seconds: 1,
    };

    await writeJobScript(controlDir, execution);

    const chunks: Array<{ stream: string; text: string }> = [];
    let chain: Promise<void> = Promise.resolve();
    const child = spawnJobScript({
      attemptId: 'att_chunk',
      controlDir,
      workspacePath: projectPath,
      projectPath,
      execution,
      env: {},
      logs,
      attachLogs: false,
      onLogChunk: (stream, chunk) => {
        chain = chain.then(() => {
          chunks.push({ stream, text: chunk.toString('utf8') });
        });
      },
    });

    await child.waitForExit();
    await chain;

    expect(chunks.some((c) => c.stream === 'stdout' && c.text.includes('HELLO_CHUNK'))).toBe(true);
  }, 20_000);
});
