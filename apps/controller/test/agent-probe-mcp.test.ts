import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { requestAgentProbe } from '../src/agents/probe.js';
import { handleToolCall } from '../src/mcp/handlers.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function mockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(raw);
    },
  } as unknown as WebSocket & { sent: string[] };
}

describe('agent_probe MCP (§2.7)', () => {
  it('returns requested:true and sends refresh_capabilities when agent is connected', async () => {
    const socket = mockSocket();
    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        'agt_probe',
        {
          agentId: 'agt_probe',
          socket,
          protocolVersion: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
    ]);
    const db = openDatabase(':memory:');
    migrateToLatest(db);

    const result = await handleToolCall(
      {
        db,
        dataDir: '/tmp',
        identity: { client_id: 'test', transport: 'internal', session_id: null },
        connectedAgents,
      },
      'agent_probe',
      { agent_id: 'agt_probe' },
    );

    expect(result).toEqual({ requested: true });
    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0] ?? '{}') as { type: string; payload: unknown };
    expect(frame.type).toBe('refresh_capabilities');
    expect(frame.payload).toEqual({});
    db.close();
  });

  it('returns agent_lost when the agent is not connected', async () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    const result = await handleToolCall(
      {
        db,
        dataDir: '/tmp',
        identity: { client_id: 'test', transport: 'internal', session_id: null },
        connectedAgents: new Map(),
      },
      'agent_probe',
      { agent_id: 'agt_offline' },
    );

    expect(result).toEqual({
      error: {
        category: 'agent_lost',
        message: "Agent 'agt_offline' is not currently connected",
        retryable: true,
      },
    });
    db.close();
  });

  it('shares the same probe implementation as the admin API', () => {
    const socket = mockSocket();
    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        'agt_shared',
        {
          agentId: 'agt_shared',
          socket,
          protocolVersion: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
    ]);
    expect(requestAgentProbe(connectedAgents, 'agt_shared')).toEqual({ requested: true });
    expect(socket.sent).toHaveLength(1);
  });
});
