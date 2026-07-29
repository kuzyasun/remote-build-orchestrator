import type { StructuredErrorDetails } from '@rbo/shared';
import type { ConnectedAgent } from '../websocket/server.js';

export type AgentProbeResult = { requested: true } | { error: StructuredErrorDetails };

/** Request a capability re-probe from a connected agent (admin API + MCP). */
export function requestAgentProbe(
  connectedAgents: Map<string, ConnectedAgent> | undefined,
  agentId: string,
): AgentProbeResult {
  const connected = connectedAgents?.get(agentId);
  if (!connected) {
    return {
      error: {
        category: 'agent_lost',
        message: `Agent '${agentId}' is not currently connected`,
        retryable: true,
      },
    };
  }
  connected.socket.send(
    JSON.stringify({
      protocol: 1,
      type: 'refresh_capabilities',
      message_id: `msg_${Date.now()}`,
      sent_at: new Date().toISOString(),
      attempt_id: null,
      lease_id: null,
      lease_epoch: null,
      payload: {},
    }),
  );
  return { requested: true };
}
