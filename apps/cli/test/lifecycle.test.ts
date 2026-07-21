import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAgentInitialized, runAgentInit, runAgentStart } from '../src/commands/agent.js';
import { isControllerInitialized, runControllerStart } from '../src/commands/controller.js';
import {
  agentLogPath,
  agentPidPath,
  assertNoLivePid,
  controllerLogPath,
  controllerPidPath,
  isProcessAlive,
  spawnDetachedDaemon,
  stripDaemonFlag,
} from '../src/commands/daemon.js';
import { parseDataDirFlag, parseStateDirFlag } from '../src/commands/flags.js';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('isControllerInitialized', () => {
  it('returns false when identity files are missing', async () => {
    const dataDir = await tempDir('rbo-cli-ctrl-uninit-');
    expect(await isControllerInitialized(dataDir)).toBe(false);
  });

  it('returns true after controller init provisions identity', async () => {
    const dataDir = await tempDir('rbo-cli-ctrl-init-');
    await ensureControllerIdentity(dataDir);
    expect(await isControllerInitialized(dataDir)).toBe(true);
  });
});

describe('isAgentInitialized / runAgentInit', () => {
  it('returns false before agent init', async () => {
    const stateDir = await tempDir('rbo-cli-agent-uninit-');
    expect(await isAgentInitialized(stateDir)).toBe(false);
  });

  it('runAgentInit creates a complete agent.json config', async () => {
    const stateDir = await tempDir('rbo-cli-agent-init-');
    const result = await runAgentInit({ stateDir });
    expect(existsSync(join(stateDir, 'agent.json'))).toBe(true);
    const config = JSON.parse(await readFile(join(stateDir, 'agent.json'), 'utf8')) as {
      initialized_at: string;
      schema_version: number;
      controller_url: string;
      display_name: string;
      max_jobs: number;
    };
    expect(config.schema_version).toBe(1);
    expect(config.initialized_at).toBe(result.initialized_at);
    expect(config.controller_url).toBe('');
    expect(config.display_name).toBe('rbo-agent');
    expect(config.max_jobs).toBe(1);
    expect(await isAgentInitialized(stateDir)).toBe(true);
    expect(result.configPath).toBe(join(stateDir, 'agent.json'));
    expect(result.configWritten).toBe(true);
  });

  it('runAgentInit is idempotent', async () => {
    const stateDir = await tempDir('rbo-cli-agent-reinit-');
    const first = await runAgentInit({ stateDir });
    const second = await runAgentInit({ stateDir });
    expect(second.initialized_at).toBe(first.initialized_at);
    expect(second.configWritten).toBe(false);
  });

  it('runAgentInit does not overwrite an existing agent.json', async () => {
    const stateDir = await tempDir('rbo-cli-agent-config-keep-');
    await runAgentInit({ stateDir });
    const configPath = join(stateDir, 'agent.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schema_version: 1,
        initialized_at: '2020-01-01T00:00:00.000Z',
        controller_url: 'wss://kept.example:7411/agent',
        controller_fingerprint: `sha256:${'e'.repeat(64)}`,
        display_name: 'kept',
      }),
      'utf8',
    );
    await runAgentInit({ stateDir });
    const kept = JSON.parse(await readFile(configPath, 'utf8')) as { display_name: string };
    expect(kept.display_name).toBe('kept');
  });
});

describe('start without init guards', () => {
  it('runControllerStart refuses when controller is not initialized', async () => {
    const dataDir = await tempDir('rbo-cli-ctrl-start-guard-');
    await expect(runControllerStart({ dataDir, daemon: false })).rejects.toThrow(
      /rbo controller init/i,
    );
  });

  it('runAgentStart refuses when agent is not initialized', async () => {
    const stateDir = await tempDir('rbo-cli-agent-start-guard-');
    await expect(runAgentStart({ stateDir, daemon: false })).rejects.toThrow(/rbo agent init/i);
  });
});

describe('path override flags', () => {
  it('parseDataDirFlag accepts --data-dir before or after the subcommand token', () => {
    expect(parseDataDirFlag(['init', '--data-dir', '/data'])).toEqual({
      dataDir: '/data',
      rest: ['init'],
    });
    expect(parseDataDirFlag(['--data-dir', '/data', 'start', '--daemon'])).toEqual({
      dataDir: '/data',
      rest: ['start', '--daemon'],
    });
  });

  it('parseStateDirFlag accepts --state-dir for agent init/start', () => {
    expect(parseStateDirFlag(['start', '--state-dir', '/agent', '--daemon'])).toEqual({
      stateDir: '/agent',
      rest: ['start', '--daemon'],
    });
  });
});

describe('daemon helpers', () => {
  it('stripDaemonFlag removes --daemon and reports whether it was present', () => {
    expect(stripDaemonFlag(['start', '--daemon'])).toEqual({ daemon: true, args: ['start'] });
    expect(stripDaemonFlag(['start', '--data-dir', '/x'])).toEqual({
      daemon: false,
      args: ['start', '--data-dir', '/x'],
    });
  });

  it('joins PID and log paths under data/state dirs', () => {
    expect(controllerPidPath('/data/rbo')).toBe(join('/data/rbo', 'run', 'controller.pid'));
    expect(controllerLogPath('/data/rbo')).toBe(join('/data/rbo', 'logs', 'controller.log'));
    expect(agentPidPath('/state/agent')).toBe(join('/state/agent', 'run', 'agent.pid'));
    expect(agentLogPath('/state/agent')).toBe(join('/state/agent', 'logs', 'agent.log'));
  });

  it('spawnDetachedDaemon writes pid file via injectable spawner', async () => {
    const base = await tempDir('rbo-cli-daemon-spawn-');
    const pidFile = join(base, 'run', 'test.pid');
    const logFile = join(base, 'logs', 'test.log');
    const spawn = vi.fn(() => ({
      pid: 4242,
      unref: vi.fn(),
      on: vi.fn(),
    }));

    const pid = await spawnDetachedDaemon({
      command: process.execPath,
      args: ['script.js', 'controller', 'start'],
      pidFile,
      logFile,
      spawn,
    });

    expect(pid).toBe(4242);
    expect(spawn).toHaveBeenCalledOnce();
    expect(await readFile(pidFile, 'utf8')).toBe('4242\n');
    await mkdir(join(base, 'logs'), { recursive: true });
    expect(existsSync(logFile)).toBe(true);
  });

  it('spawnDetachedDaemon rejects when spawn emits error', async () => {
    const base = await tempDir('rbo-cli-daemon-err-');
    const pidFile = join(base, 'run', 'test.pid');
    const logFile = join(base, 'logs', 'test.log');
    const spawn = vi.fn(() => ({
      pid: undefined as number | undefined,
      unref: vi.fn(),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'error') {
          setImmediate(() => listener(new Error('spawn ENOENT')));
        }
      },
    }));

    await expect(
      spawnDetachedDaemon({
        command: 'missing-binary',
        args: [],
        pidFile,
        logFile,
        spawn,
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('assertNoLivePid refuses when pid file names this process', async () => {
    const base = await tempDir('rbo-cli-daemon-live-');
    const pidFile = join(base, 'run', 'live.pid');
    await mkdir(join(base, 'run'), { recursive: true });
    await writeFile(pidFile, `${process.pid}\n`, 'utf8');
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(() => assertNoLivePid(pidFile, 'Controller')).toThrow(/already be running/);
  });

  it('assertNoLivePid allows stale pid files', async () => {
    const base = await tempDir('rbo-cli-daemon-stale-');
    const pidFile = join(base, 'run', 'stale.pid');
    await mkdir(join(base, 'run'), { recursive: true });
    // PID 1 may or may not exist depending on OS; use an absurd high pid unlikely to be alive.
    await writeFile(pidFile, '2147483646\n', 'utf8');
    if (!isProcessAlive(2147483646)) {
      expect(() => assertNoLivePid(pidFile, 'Agent')).not.toThrow();
    }
  });
});
