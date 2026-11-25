import { describeWindowsExecutorResolution } from '@rbo/executor';
import { describe, expect, it, vi } from 'vitest';
import { probeCapabilities } from '../src/capabilities/probe.js';

vi.mock('@rbo/executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rbo/executor')>()),
  describeWindowsExecutorResolution: vi.fn(),
}));

const input = { agentId: 'agt_windows', displayName: 'Windows Agent', maxJobs: 1 };

describe.skipIf(process.platform !== 'win32')('Windows Agent Job Object capability', () => {
  it('cannot accept jobs without the native helper', async () => {
    vi.mocked(describeWindowsExecutorResolution).mockReturnValueOnce({
      path: null,
      reason: 'not_installed',
      detail: 'The Windows executor package is missing.',
    });
    const capabilities = await probeCapabilities(input);
    expect(capabilities.execution.supports_process_tree_kill).toBe(false);
    expect(capabilities.accepting_jobs).toBe(false);
  });

  it('advertises the helper when the native executable resolves', async () => {
    const path = 'C:\\RBO\\rbo-windows-executor.exe';
    vi.mocked(describeWindowsExecutorResolution).mockReturnValueOnce({
      path,
      reason: 'found',
      detail: path,
    });
    const capabilities = await probeCapabilities(input);
    expect(capabilities.execution.supports_process_tree_kill).toBe(true);
    expect(capabilities.accepting_jobs).toBe(true);
  });
});
