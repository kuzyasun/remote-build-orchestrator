import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRuntimeStatusPath } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAgentStatus,
  connectionFromLogTail,
  formatAgentStatus,
} from '../src/commands/agent-status.js';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-agent-status-'));
  temps.push(dir);
  return dir;
}

describe('rbo agent status', () => {
  it('reads the latest connection failure from the agent log', () => {
    const text = [
      JSON.stringify({
        message: 'agent authenticated',
        context: { agentId: 'agt_old' },
      }),
      JSON.stringify({
        message: 'connection failed, retrying',
        context: { error: 'Error: getaddrinfo ENOTFOUND kpc' },
      }),
    ].join('\n');
    expect(connectionFromLogTail(text)).toEqual({
      connection: 'error',
      detail: 'getaddrinfo ENOTFOUND kpc',
    });
  });

  it('reports a stopped uninitialized agent without OS-service instructions', async () => {
    const stateDir = tempDir();
    const report = await collectAgentStatus({
      stateDir,
      findPids: async () => [],
    });
    const output = formatAgentStatus(report);
    expect(output).toContain('process:      stopped');
    expect(output).toContain('connection:   not connected');
    expect(output).toContain('binding:      none');
    expect(output).toContain('controller:   not configured');
    expect(output).toContain('not initialized');
    expect(output).not.toMatch(/dry run|launchctl|rbo-agent\.exe|Program Files/i);
  });

  it('reports a running agent, stored credential, and connect error without secrets', async () => {
    const stateDir = tempDir();
    writeFileSync(
      join(stateDir, 'agent.json'),
      JSON.stringify({
        controller_url: 'wss://KPC:7411/agent',
        controller_fingerprint: 'sha256:abc',
        display_name: 'mac1',
      }),
    );
    writeFileSync(
      join(stateDir, 'agent-state.json'),
      JSON.stringify({
        devicePublicKeyPem: '-----BEGIN PUBLIC KEY-----\npub\n-----END PUBLIC KEY-----',
        devicePrivateKeyPem: '-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----',
        credential: 'secret-credential-value',
        agentId: 'agt_01EXAMPLE',
      }),
    );
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    writeFileSync(
      join(stateDir, 'logs', 'agent.log'),
      `${JSON.stringify({
        message: 'connection failed, retrying',
        context: { error: 'Error: getaddrinfo ENOTFOUND kpc' },
      })}\n`,
    );

    const report = await collectAgentStatus({
      stateDir,
      findPids: async () => [72750],
    });
    const output = formatAgentStatus(report);
    expect(output).toContain('process:      running (pid 72750)');
    expect(output).toContain('connection:   not connected (getaddrinfo ENOTFOUND kpc)');
    expect(output).toContain('binding:      credential stored (agt_01EXAMPLE)');
    expect(output).toContain('controller:   wss://KPC:7411/agent');
    expect(output).toContain('fingerprint:  sha256:abc');
    expect(output).toContain('name:         mac1');
    expect(output).not.toContain('secret-key');
    expect(output).not.toContain('secret-credential-value');
  });

  it('prefers a live runtime snapshot over an older log line', async () => {
    const stateDir = tempDir();
    writeFileSync(
      join(stateDir, 'agent.json'),
      JSON.stringify({ controller_url: 'wss://192.168.1.20:7411/agent' }),
    );
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    writeFileSync(
      join(stateDir, 'logs', 'agent.log'),
      `${JSON.stringify({
        message: 'connection failed, retrying',
        context: { error: 'Error: old' },
      })}\n`,
    );
    mkdirSync(join(stateDir, 'run'), { recursive: true });
    writeFileSync(
      agentRuntimeStatusPath(stateDir),
      `${JSON.stringify({
        pid: 42,
        updated_at: '2026-09-25T00:00:00.000Z',
        connection: 'authenticated',
        agent_id: 'agt_live',
      })}\n`,
    );

    const report = await collectAgentStatus({
      stateDir,
      findPids: async () => [42],
    });
    expect(formatAgentStatus(report)).toContain('connection:   connected');
  });
});
