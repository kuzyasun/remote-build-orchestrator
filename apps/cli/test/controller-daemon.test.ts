import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runController } from '@rbo/controller/run';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runControllerStart } from '../src/commands/controller.js';
import { isDaemonChild, spawnDetachedDaemon } from '../src/commands/daemon.js';
import { ensureNotRunningOrReplace } from '../src/commands/process-lifecycle.js';

vi.mock('@rbo/controller/run', () => ({ runController: vi.fn() }));
vi.mock('../src/commands/process-lifecycle.js', () => ({
  ensureNotRunningOrReplace: vi.fn(async () => true),
}));
vi.mock('../src/commands/daemon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/daemon.js')>()),
  isDaemonChild: vi.fn(() => false),
  spawnDetachedDaemon: vi.fn(async () => 4242),
}));

const dirs: string[] = [];
async function initializedDir() {
  const dir = await mkdtemp(join(tmpdir(), 'rbo-controller-daemon-'));
  dirs.push(dir);
  await mkdir(join(dir, 'security'));
  await writeFile(join(dir, 'security/controller-cert.pem'), 'test');
  await writeFile(join(dir, 'security/controller.json'), JSON.stringify({ controller_id: 'test' }));
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.mocked(isDaemonChild).mockReturnValue(false);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Controller daemon startup', () => {
  it('checks the running role and requests child-specific readiness before returning the PID', async () => {
    const dataDir = await initializedDir();
    await expect(
      runControllerStart({ dataDir, daemon: true, cliScriptPath: '/rbo.js' }),
    ).resolves.toBe(4242);
    expect(ensureNotRunningOrReplace).toHaveBeenCalledOnce();
    expect(spawnDetachedDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        readyMessage: 'rbo:controller-ready',
        args: ['/rbo.js', 'controller', 'start', '--data-dir', dataDir],
      }),
    );
    expect(runController).not.toHaveBeenCalled();
  });

  it('does not mistake the waiting launcher for a running Controller in the IPC child', async () => {
    const dataDir = await initializedDir();
    vi.mocked(isDaemonChild).mockReturnValue(true);
    await runControllerStart({ dataDir });
    expect(ensureNotRunningOrReplace).not.toHaveBeenCalled();
    expect(runController).toHaveBeenCalledWith({ dataDir });
  });

  it('keeps the running-role guard for ordinary foreground starts', async () => {
    const dataDir = await initializedDir();
    await runControllerStart({ dataDir });
    expect(ensureNotRunningOrReplace).toHaveBeenCalledOnce();
    expect(runController).toHaveBeenCalledWith({ dataDir });
  });
});
