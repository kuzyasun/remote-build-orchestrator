import { describe, expect, it, vi } from 'vitest';
import { parseReplaceFlag } from '../src/commands/flags.js';
import {
  confirmReplaceOrThrow,
  ensureNotRunningOrReplace,
  stopRoleForCli,
} from '../src/commands/process-lifecycle.js';

describe('parseReplaceFlag', () => {
  it('strips --replace and reports whether it was present', () => {
    expect(parseReplaceFlag(['--daemon', '--replace'])).toEqual({
      replace: true,
      rest: ['--daemon'],
    });
    expect(parseReplaceFlag(['--daemon'])).toEqual({ replace: false, rest: ['--daemon'] });
  });
});

describe('confirmReplaceOrThrow', () => {
  it('returns replace when --replace is set without prompting', async () => {
    const prompt = vi.fn(async () => 'n');
    await expect(
      confirmReplaceOrThrow({
        role: 'controller',
        pids: [1],
        replace: true,
        isTTY: true,
        prompt,
      }),
    ).resolves.toBe('replace');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('defaults to yes on empty TTY answer', async () => {
    await expect(
      confirmReplaceOrThrow({
        role: 'agent',
        pids: [2, 3],
        replace: false,
        isTTY: true,
        prompt: async () => '  ',
      }),
    ).resolves.toBe('replace');
  });

  it('returns abort when TTY answer is no', async () => {
    await expect(
      confirmReplaceOrThrow({
        role: 'controller',
        pids: [4],
        replace: false,
        isTTY: true,
        prompt: async () => 'n',
      }),
    ).resolves.toBe('abort');
  });

  it('throws on non-TTY without --replace', async () => {
    await expect(
      confirmReplaceOrThrow({
        role: 'controller',
        pids: [5],
        replace: false,
        isTTY: false,
      }),
    ).rejects.toThrow(/--replace/);
  });
});

describe('ensureNotRunningOrReplace / stopRoleForCli', () => {
  it('returns true immediately when no live pids', async () => {
    const stopRole = vi.fn();
    await expect(
      ensureNotRunningOrReplace('controller', {
        dataDir: '/data',
        findPids: async () => [],
        stopRole,
      }),
    ).resolves.toBe(true);
    expect(stopRole).not.toHaveBeenCalled();
  });

  it('stops after --replace', async () => {
    const stopRole = vi.fn(async () => ({ stopped: [9], alreadyStopped: false }));
    const logs: string[] = [];
    await expect(
      ensureNotRunningOrReplace('controller', {
        dataDir: '/data',
        replace: true,
        findPids: async () => [9],
        stopRole,
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toBe(true);
    expect(stopRole).toHaveBeenCalledOnce();
    expect(logs.some((line) => line.includes('pid=9'))).toBe(true);
  });

  it('returns false when operator declines', async () => {
    const stopRole = vi.fn();
    await expect(
      ensureNotRunningOrReplace('agent', {
        stateDir: '/agent',
        findPids: async () => [11],
        stopRole,
        confirm: async () => 'abort',
        log: () => {},
      }),
    ).resolves.toBe(false);
    expect(stopRole).not.toHaveBeenCalled();
  });

  it('stopRoleForCli reports already stopped when idle', async () => {
    const logs: string[] = [];
    await expect(
      stopRoleForCli('controller', {
        dataDir: '/data',
        findPids: async () => [],
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toEqual({ stopped: [], alreadyStopped: true });
    expect(logs.some((line) => /not running/i.test(line))).toBe(true);
  });
});
