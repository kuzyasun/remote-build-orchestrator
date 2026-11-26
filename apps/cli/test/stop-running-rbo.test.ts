import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStalePidFile,
  findLiveRolePids,
  matchRboDaemonRole,
  readLivePidFromFile,
  registerRoleInstance,
  resolveDaemonPidFiles,
  shouldSkipInstallStop,
  stopRoleProcesses,
  stopRunningRbo,
} from '../scripts/stop-running-rbo.mjs';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('stop-running-rbo (install auto-stop)', () => {
  it('skips when RBO_SKIP_INSTALL_STOP=1 or install is not global', () => {
    expect(shouldSkipInstallStop({ RBO_SKIP_INSTALL_STOP: '1', npm_config_global: 'true' })).toBe(
      true,
    );
    expect(shouldSkipInstallStop({})).toBe(true);
    expect(shouldSkipInstallStop({ npm_config_global: 'false' })).toBe(true);
    expect(shouldSkipInstallStop({ npm_config_global: 'true' })).toBe(false);
  });

  it('matches controller/agent start command lines and ignores unrelated rbo CLIs', () => {
    expect(
      matchRboDaemonRole(
        String.raw`"C:\nvm\node.exe" C:\npm\node_modules\@gemslibe\rbo\dist\rbo.js controller start`,
      ),
    ).toBe('controller');
    expect(
      matchRboDaemonRole(
        '/usr/bin/node /opt/npm/node_modules/@gemslibe/rbo/dist/rbo.js agent start',
      ),
    ).toBe('agent');
    expect(
      matchRboDaemonRole('/usr/bin/node /opt/npm/node_modules/@gemslibe/rbo/dist/rbo-mcp-stdio.js'),
    ).toBeNull();
    expect(matchRboDaemonRole('/usr/bin/node /opt/rbo.js doctor')).toBeNull();
    expect(matchRboDaemonRole(undefined)).toBeNull();
  });

  it('resolves default and env-overridden pid file paths', () => {
    const home = join(realpathSync(tmpdir()), 'rbo-home-fake');
    const files = resolveDaemonPidFiles({
      env: {},
      home,
    });
    expect(files).toEqual([
      { role: 'controller', path: join(home, '.rbo', 'run', 'controller.pid') },
      { role: 'agent', path: join(home, '.rbo', 'agent', 'run', 'agent.pid') },
    ]);

    const dataDir = join(home, 'rbo-data');
    const stateDir = join(home, 'agent-state');
    const overridden = resolveDaemonPidFiles({
      env: { RBO_DATA_DIR: dataDir, RBO_AGENT_STATE_DIR: stateDir },
      home,
    });
    expect(overridden).toEqual([
      { role: 'controller', path: join(dataDir, 'run', 'controller.pid') },
      { role: 'agent', path: join(stateDir, 'run', 'agent.pid') },
    ]);

    const explicit = resolveDaemonPidFiles({
      env: { RBO_DATA_DIR: dataDir, RBO_AGENT_STATE_DIR: stateDir },
      home,
      dataDir: join(home, 'explicit-controller'),
      stateDir: join(home, 'explicit-agent'),
    });
    expect(explicit).toEqual([
      { role: 'controller', path: join(home, 'explicit-controller', 'run', 'controller.pid') },
      { role: 'agent', path: join(home, 'explicit-agent', 'run', 'agent.pid') },
    ]);
  });

  it('reads a live pid file and ignores stale/missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-pid-'));
    temps.push(dir);
    const pidPath = join(dir, 'controller.pid');
    expect(readLivePidFromFile(pidPath, () => true)).toBeNull();

    writeFileSync(pidPath, '4242\n', 'utf8');
    expect(readLivePidFromFile(pidPath, (pid) => pid === 4242)).toBe(4242);
    expect(readLivePidFromFile(pidPath, () => false)).toBeNull();
  });

  it('clearStalePidFile removes dead pid markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-stale-'));
    temps.push(dir);
    const pidPath = join(dir, 'controller.pid');
    writeFileSync(pidPath, '4242\n', 'utf8');
    expect(clearStalePidFile(pidPath, () => false)).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('finds the requested instance and ignores unrelated processes named in stale PID files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-find-'));
    temps.push(dir);
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(join(dir, 'run', 'controller.pid'), '111\n', 'utf8');

    const pids = await findLiveRolePids('controller', {
      dataDir: dir,
      selfPid: 999,
      isAlive: (pid) => pid === 111 || pid === 222 || pid === 333,
      listProcesses: async () => [
        { pid: 111, commandLine: '/usr/bin/node /x/unrelated.js' },
        {
          pid: 222,
          commandLine: `/usr/bin/node /x/rbo.js controller start --data-dir "${dir}"`,
        },
        {
          pid: 333,
          commandLine: '/usr/bin/node /x/rbo.js controller start --data-dir a-different-instance',
        },
        {
          pid: 999,
          commandLine: '/usr/bin/node /x/rbo.js controller start',
        },
      ],
    });
    expect(pids).toEqual([222]);
  });

  it.each(['controller', 'agent'] as const)(
    'matches unflagged %s starts only in their registered scope',
    async (role) => {
      const base = mkdtempSync(join(tmpdir(), 'rbo-foreground-scope-'));
      temps.push(base);
      const selected = join(base, 'registered');
      const alias = join(base, 'registered-alias');
      const callerScope = join(base, 'caller');
      const directoryKey = role === 'controller' ? 'dataDir' : 'stateDir';
      const ownProcess = {
        pid: process.pid,
        commandLine: `/usr/bin/node /usr/local/bin/rbo ${role} start`,
        startedAt: 'current-start',
      };
      const another = { ...ownProcess, pid: process.pid + 1, startedAt: 'another-start' };
      const nativeMarker = join(selected, 'run', `${role}.pid`);
      mkdirSync(join(selected, 'run'), { recursive: true });
      mkdirSync(join(callerScope, 'run'), { recursive: true });
      let aliasAvailable = false;
      try {
        symlinkSync(selected, alias, process.platform === 'win32' ? 'junction' : 'dir');
        aliasAvailable = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
      writeFileSync(nativeMarker, `${ownProcess.pid}\n`);
      writeFileSync(join(callerScope, 'run', `${role}.pid`), `${ownProcess.pid}\n`);
      const unregister = await registerRoleInstance(role, {
        [directoryKey]: selected,
        listProcesses: async () => [ownProcess],
      });
      try {
        const common = {
          isAlive: () => true,
          selfPid: -1,
          listProcesses: async () => [ownProcess, another],
        };
        const callerOptions = {
          ...common,
          env: { RBO_DATA_DIR: callerScope, RBO_AGENT_STATE_DIR: callerScope },
        };
        const stopped: number[] = [];
        const stop = await stopRoleProcesses(role, {
          ...callerOptions,
          stopPid: async (pid) => {
            stopped.push(pid);
          },
        });
        expect(stop).toEqual({ stopped: [], alreadyStopped: true });
        expect(stopped).toEqual([]);
        expect(await findLiveRolePids(role, { ...common, [directoryKey]: selected })).toEqual([
          ownProcess.pid,
        ]);
        if (aliasAvailable) {
          expect(await findLiveRolePids(role, { ...common, [directoryKey]: alias })).toEqual([
            ownProcess.pid,
          ]);
        }
        expect(
          await findLiveRolePids(role, {
            ...common,
            [directoryKey]: selected,
            listProcesses: async () => [{ ...ownProcess, startedAt: 'reused-start' }],
          }),
        ).toEqual([]);
      } finally {
        unregister();
      }
      expect(existsSync(`${nativeMarker}.${ownProcess.pid}.instance`)).toBe(false);
      expect(readFileSync(nativeMarker, 'utf8')).toBe(`${ownProcess.pid}\n`);
    },
  );

  it('stopRoleProcesses stops matched role strictly and clears pid file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-stop-role-'));
    temps.push(dir);
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(join(dir, 'run', 'controller.pid'), '111\n', 'utf8');

    const killed: number[] = [];
    const live = new Set([111]);
    const result = await stopRoleProcesses('controller', {
      dataDir: dir,
      isAlive: (pid) => live.has(pid),
      listProcesses: async () => [
        { pid: 111, commandLine: `/usr/bin/node /x/rbo.js controller start --data-dir "${dir}"` },
      ],
      stopPid: async (pid) => {
        killed.push(pid);
        live.delete(pid);
      },
      log: () => {},
      warn: () => {},
      strict: true,
    });

    expect(result).toEqual({ stopped: [111], alreadyStopped: false });
    expect(killed).toEqual([111]);
    expect(existsSync(join(dir, 'run', 'controller.pid'))).toBe(false);
  });

  it('stopRoleProcesses throws when strict and process stays alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-stop-strict-'));
    temps.push(dir);
    await expect(
      stopRoleProcesses('agent', {
        stateDir: dir,
        isAlive: () => true,
        listProcesses: async () => [
          { pid: 55, commandLine: `/usr/bin/node /x/rbo.js agent start --state-dir "${dir}"` },
        ],
        stopPid: async () => {},
        log: () => {},
        warn: () => {},
        strict: true,
      }),
    ).rejects.toThrow(/still alive/);
  });

  it('stopRunningRbo stops verified processes and continues on a stop failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-stop-'));
    temps.push(dir);
    mkdirSync(join(dir, '.rbo', 'run'), { recursive: true });
    writeFileSync(join(dir, '.rbo', 'run', 'controller.pid'), '111\n', 'utf8');

    const killed: number[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];

    await stopRunningRbo({
      env: { npm_config_global: 'true' },
      home: dir,
      listProcesses: async () => [
        { pid: 111, commandLine: '/usr/bin/node /x/rbo.js controller start' },
        {
          pid: 222,
          commandLine:
            '/usr/bin/node /x/node_modules/@gemslibe/rbo/dist/rbo.js agent start --daemon',
        },
        { pid: 333, commandLine: '/usr/bin/node /x/rbo-mcp-stdio.js' },
        { pid: 999, commandLine: '/usr/bin/node /x/rbo.js agent start' },
      ],
      isAlive: (pid) => pid === 111 || pid === 222 || pid === 999,
      stopPid: async (pid) => {
        if (pid === 999) {
          throw new Error('access denied');
        }
        killed.push(pid);
      },
      log: (msg) => logs.push(msg),
      warn: (msg) => warnings.push(msg),
    });

    expect(killed.sort()).toEqual([111, 222]);
    expect(logs.some((line) => line.includes('controller') && line.includes('111'))).toBe(true);
    expect(logs.some((line) => line.includes('agent') && line.includes('222'))).toBe(true);
    expect(warnings.some((line) => line.includes('999'))).toBe(true);
  });

  it('skips a process whose start time changed before it can be stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rbo-replaced-'));
    temps.push(dir);
    let scan = 0;
    const stopped: number[] = [];
    await stopRoleProcesses('controller', {
      dataDir: dir,
      listProcesses: async () => [
        {
          pid: 55,
          commandLine: `/usr/bin/node /x/rbo.js controller start --data-dir "${dir}"`,
          startedAt: String(scan++),
        },
      ],
      isAlive: () => true,
      stopPid: async (pid) => {
        stopped.push(pid);
      },
    });
    expect(stopped).toEqual([]);
    expect(scan).toBe(2);
  });

  it('stopRunningRbo is a no-op when skip env is set', async () => {
    let listed = false;
    await stopRunningRbo({
      env: { RBO_SKIP_INSTALL_STOP: '1' },
      home: tmpdir(),
      listProcesses: async () => {
        listed = true;
        return [];
      },
      isAlive: () => true,
      stopPid: async () => {
        throw new Error('should not stop');
      },
      log: () => {},
      warn: () => {},
    });
    expect(listed).toBe(false);
  });
});
