import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  matchRboDaemonRole,
  readLivePidFromFile,
  resolveDaemonPidFiles,
  shouldSkipInstallStop,
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
    const home = join(tmpdir(), 'rbo-home-fake');
    const files = resolveDaemonPidFiles({
      env: {},
      home,
    });
    expect(files).toEqual([
      { role: 'controller', path: join(home, '.rbo', 'run', 'controller.pid') },
      { role: 'agent', path: join(home, '.rbo', 'agent', 'run', 'agent.pid') },
    ]);

    const overridden = resolveDaemonPidFiles({
      env: { RBO_DATA_DIR: 'D:\\rbo-data', RBO_AGENT_STATE_DIR: 'E:\\agent-state' },
      home,
    });
    expect(overridden).toEqual([
      { role: 'controller', path: join('D:\\rbo-data', 'run', 'controller.pid') },
      { role: 'agent', path: join('E:\\agent-state', 'run', 'agent.pid') },
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

  it('stopRunningRbo stops matched processes and pid-file daemons, then continues on kill failure', async () => {
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
        {
          pid: 222,
          commandLine:
            '/usr/bin/node /x/node_modules/@gemslibe/rbo/dist/rbo.js agent start --daemon',
        },
        { pid: 333, commandLine: '/usr/bin/node /x/rbo-mcp-stdio.js' },
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
      extraPids: [999],
    });

    expect(killed.sort()).toEqual([111, 222]);
    expect(logs.some((line) => line.includes('controller') && line.includes('111'))).toBe(true);
    expect(logs.some((line) => line.includes('agent') && line.includes('222'))).toBe(true);
    expect(warnings.some((line) => line.includes('999'))).toBe(true);
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
