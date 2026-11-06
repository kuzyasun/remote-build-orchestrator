import { EventEmitter } from 'node:events';
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
import { parseDataDirFlag, parseReplaceFlag, parseStateDirFlag } from '../src/commands/flags.js';
import { ensureNotRunningOrReplace, stopRoleForCli } from '../src/commands/process-lifecycle.js';

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
    const result = await runAgentInit({ stateDir, skipDiscovery: true });
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
    const first = await runAgentInit({ stateDir, skipDiscovery: true });
    const second = await runAgentInit({ stateDir, skipDiscovery: true });
    expect(second.initialized_at).toBe(first.initialized_at);
    expect(second.configWritten).toBe(false);
  });

  it('runAgentInit --force clears a credential when the controller target changes', async () => {
    const stateDir = await tempDir('rbo-cli-agent-rebind-');
    await runAgentInit({ stateDir, skipDiscovery: true });
    await writeFile(
      join(stateDir, 'agent.json'),
      JSON.stringify({
        schema_version: 1,
        controller_url: 'wss://old-controller:7411/agent',
        controller_fingerprint: 'sha256:aa',
      }),
    );
    await writeFile(
      join(stateDir, 'agent-state.json'),
      JSON.stringify({
        devicePublicKeyPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
        devicePrivateKeyPem: '-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----',
        credential: 'secret-credential',
        agentId: 'agt_old',
      }),
    );
    const result = await runAgentInit({ stateDir, force: true, skipDiscovery: true });
    expect(result.credentialCleared).toBe(true);
    const state = JSON.parse(await readFile(join(stateDir, 'agent-state.json'), 'utf8')) as {
      credential?: string;
      agentId?: string;
      devicePrivateKeyPem: string;
    };
    expect(state.credential).toBeUndefined();
    expect(state.agentId).toBeUndefined();
    expect(state.devicePrivateKeyPem).toContain('PRIVATE KEY');
  });

  it('runAgentInit does not overwrite an existing agent.json', async () => {
    const stateDir = await tempDir('rbo-cli-agent-config-keep-');
    await runAgentInit({ stateDir, skipDiscovery: true });
    const configPath = join(stateDir, 'agent.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schema_version: 1,
        initialized_at: '2020-01-01T00:00:00.000Z',
        controller_url: 'wss://existing.test:7411/agent',
        display_name: 'kept',
        max_jobs: 1,
      }),
      'utf8',
    );
    await runAgentInit({ stateDir, skipDiscovery: true });
    const kept = JSON.parse(await readFile(configPath, 'utf8')) as { display_name: string };
    expect(kept.display_name).toBe('kept');
  });

  it('runAgentInit honors skipDiscovery: true to bypass mDNS scanning', async () => {
    const stateDir = await tempDir('rbo-cli-agent-skip-disc-');
    const result = await runAgentInit({ stateDir, skipDiscovery: true });
    expect(result.configWritten).toBe(true);
    expect(result.discovered).toBeUndefined();
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

describe('start replace / stop lifecycle', () => {
  it('parseReplaceFlag is available alongside other path flags', () => {
    expect(parseReplaceFlag(['--replace', '--daemon'])).toEqual({
      replace: true,
      rest: ['--daemon'],
    });
  });

  it('runControllerStart with --replace stops a live pid then declines when confirm aborts', async () => {
    const dataDir = await tempDir('rbo-cli-ctrl-replace-');
    await ensureControllerIdentity(dataDir);

    const stopRole = vi.fn(async () => ({ stopped: [42], alreadyStopped: false }));
    await expect(
      ensureNotRunningOrReplace('controller', {
        dataDir,
        replace: true,
        findPids: async () => [42],
        stopRole,
        log: () => {},
      }),
    ).resolves.toBe(true);
    expect(stopRole).toHaveBeenCalledOnce();

    await expect(
      ensureNotRunningOrReplace('controller', {
        dataDir,
        findPids: async () => [42],
        stopRole,
        confirm: async () => 'abort',
        log: () => {},
      }),
    ).resolves.toBe(false);
  });

  it('runControllerStop is a successful no-op when idle', async () => {
    const dataDir = await tempDir('rbo-cli-ctrl-stop-idle-');
    const result = await stopRoleForCli('controller', {
      dataDir,
      findPids: async () => [],
      log: () => {},
    });
    expect(result.alreadyStopped).toBe(true);
    expect(result.stopped).toEqual([]);
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

  function readyChild() {
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      connected: true,
      unref: vi.fn(),
      disconnect: vi.fn(),
    });
  }

  it('receives readiness over real IPC and leaves the detached child alive after disconnect', async () => {
    const base = await tempDir('rbo-cli-daemon-real-ipc-');
    const pid = await spawnDetachedDaemon({
      command: process.execPath,
      args: ['-e', "setInterval(() => {}, 1000); setTimeout(() => process.send('ready'), 50)"],
      pidFile: join(base, 'controller.pid'),
      logFile: join(base, 'controller.log'),
      readyMessage: 'ready',
      readyTimeoutMs: 5_000,
    });
    try {
      expect(isProcessAlive(pid)).toBe(true);
      expect(await readFile(join(base, 'controller.pid'), 'utf8')).toBe(`${pid}\n`);
    } finally {
      process.kill(pid);
    }
  });

  it('waits for the spawned child readiness message, then disconnects IPC', async () => {
    const base = await tempDir('rbo-cli-daemon-ready-');
    const child = readyChild();
    const spawn = vi.fn(() => child);
    const pidFile = join(base, 'controller.pid');
    let resolved = false;
    const start = spawnDetachedDaemon({
      command: process.execPath,
      args: [],
      pidFile,
      logFile: join(base, 'controller.log'),
      spawn,
      readyMessage: 'rbo:controller-ready',
    }).then((pid) => {
      resolved = true;
      return pid;
    });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    child.emit('message', 'unrelated');
    expect(resolved).toBe(false);
    child.emit('message', 'rbo:controller-ready');
    await expect(start).resolves.toBe(4242);
    expect(spawn.mock.calls[0][2]).toMatchObject({
      stdio: ['ignore', expect.any(Number), expect.any(Number), 'ipc'],
      env: { RBO_DAEMON_PARENT_PID: String(process.pid) },
    });
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.listenerCount('message')).toBe(0);
  });

  it.each(['exit', 'disconnect', 'error'])(
    'rejects on %s before readiness with the log path',
    async (event) => {
      const base = await tempDir('rbo-cli-daemon-failed-');
      const child = readyChild();
      const pidFile = join(base, 'controller.pid');
      const logFile = join(base, 'controller.log');
      const start = spawnDetachedDaemon({
        command: process.execPath,
        args: [],
        pidFile,
        logFile,
        spawn: () => child,
        readyMessage: 'rbo:controller-ready',
      });
      const rejected = expect(start).rejects.toThrow(logFile);
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      child.emit(event, 1, null);
      await rejected;
      expect(child.listenerCount('message')).toBe(0);
      expect(child.disconnect).toHaveBeenCalledOnce();
    },
  );

  it('times out with a log path and leaves the PID available for operator recovery', async () => {
    const base = await tempDir('rbo-cli-daemon-timeout-');
    const child = readyChild();
    const pidFile = join(base, 'controller.pid');
    await expect(
      spawnDetachedDaemon({
        command: process.execPath,
        args: [],
        pidFile,
        logFile: join(base, 'controller.log'),
        spawn: () => child,
        readyMessage: 'rbo:controller-ready',
        readyTimeoutMs: 50,
      }),
    ).rejects.toThrow(/may still be starting/);
    expect(await readFile(pidFile, 'utf8')).toBe('4242\n');
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.listenerCount('message')).toBe(0);
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
