import { describe, expect, it, vi } from 'vitest';
import {
  type CommandRunner,
  executeServicePlan,
  formatDryRunPlan,
  hasExecuteFlag,
  renderServiceActionPlan,
  renderServiceStartPlan,
  renderServiceStatusPlan,
  renderServiceStopPlan,
} from '../src/commands/service.js';

describe('rbo agent service CLI (§2.9)', () => {
  it('renders status/start/stop plans per platform', () => {
    expect(renderServiceStatusPlan('win32').commands[0]).toMatch(/sc(\.exe)?\s+query/i);
    expect(renderServiceStartPlan('linux').commands[0]).toMatch(/systemctl start/);
    expect(renderServiceStopPlan('darwin').commands[0]).toMatch(/launchctl stop/);
  });

  it('prints a dry-run plan without --execute', () => {
    const plan = renderServiceActionPlan('linux', 'status');
    const output = formatDryRunPlan('agent status', plan);
    expect(output).toContain('dry run');
    expect(output).toContain('systemctl status rbo-agent');
    expect(hasExecuteFlag(['--execute'])).toBe(true);
    expect(hasExecuteFlag([])).toBe(false);
  });

  it('executes plan commands via injectable CommandRunner (mock only in CI)', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (command: string) => {
        calls.push(command);
        return { stdout: 'ok', stderr: '', code: 0 };
      }),
    };
    const plan = renderServiceActionPlan('win32', 'start');
    const results = await executeServicePlan(plan, runner);
    expect(calls).toEqual(plan.commands);
    expect(results.every((result) => result.code === 0)).toBe(true);
  });

  it('stops executing after the first failing command', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (command: string) => ({
        stdout: '',
        stderr: /\bsc\.exe start\b/i.test(command) ? 'access denied' : '',
        code: /\bsc\.exe start\b/i.test(command) ? 5 : 0,
      })),
    };
    const plan = renderServiceActionPlan('win32', 'install');
    const results = await executeServicePlan(plan, runner);
    expect(results).toHaveLength(3);
    expect(results[2]?.code).toBe(5);
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });
});
