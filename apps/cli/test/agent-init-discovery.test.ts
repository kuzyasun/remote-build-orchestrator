import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredController } from '@rbo/discovery';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentInit } from '../src/commands/agent.js';

const { mockDiscover } = vi.hoisted(() => ({
  mockDiscover: vi.fn(),
}));

vi.mock('@rbo/discovery', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@rbo/discovery')>();
  return {
    ...orig,
    discoverControllers: mockDiscover,
  };
});

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-agent-init-disc-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mockDiscover.mockReset();
});

const mockControllers: DiscoveredController[] = [
  {
    name: 'discovered-ctrl',
    host: 'ctrl.local',
    addresses: ['192.168.1.88'],
    port: 7411,
    controllerId: 'controller_01JDISCOVERED',
    fingerprint: 'sha256:discovered12345',
    version: '1',
  },
];

describe('runAgentInit with mDNS discovery', () => {
  it('writes default empty config when discovery finds no controllers', async () => {
    mockDiscover.mockResolvedValue([]);

    const stateDir = tempDir();
    const result = await runAgentInit({ stateDir });

    expect(result.configWritten).toBe(true);
    expect(result.discovered).toBeUndefined();
    const config = JSON.parse(readFileSync(join(stateDir, 'agent.json'), 'utf8')) as {
      controller_url: string;
      controller_fingerprint: string;
    };
    expect(config.controller_url).toBe('');
    expect(config.controller_fingerprint).toBe('');
    expect(mockDiscover).toHaveBeenCalled();
  });

  it('does not run discovery if agent.json exists and force is false', async () => {
    mockDiscover.mockResolvedValue(mockControllers);

    const stateDir = tempDir();
    // First run (with skipDiscovery)
    await runAgentInit({ stateDir, skipDiscovery: true });
    expect(existsSync(join(stateDir, 'agent.json'))).toBe(true);

    mockDiscover.mockClear();

    // Second run without force
    const second = await runAgentInit({ stateDir });
    expect(second.configWritten).toBe(false);
    expect(second.hint).toContain('already exists');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('handles discovered controllers gracefully in non-TTY environments without hanging', async () => {
    mockDiscover.mockResolvedValue(mockControllers);

    const stateDir = tempDir();
    // process.stdin.isTTY is false in test runners
    const result = await runAgentInit({ stateDir });

    expect(result.configWritten).toBe(true);
    expect(result.discovered).toBeUndefined();
    const config = JSON.parse(readFileSync(join(stateDir, 'agent.json'), 'utf8')) as {
      controller_url: string;
      controller_fingerprint: string;
    };
    expect(config.controller_url).toBe('');
    expect(mockDiscover).toHaveBeenCalled();
  });
});
