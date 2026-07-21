import { RboError } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { requestAgentProbe } from '../agents/probe.js';
import { revokeAgent } from '../agents/registry.js';
import { listAgents } from '../agents/service.js';
import type { PairingRequestRow } from '../security/pairing.js';
import {
  approvePairingRequest,
  listPairingRequests,
  rejectPairingRequest,
} from '../security/pairing.js';
import type { ControllerDatabase } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';

// Local-only admin operations behind the CLI (§33): pairing approve/reject,
// agent revoke/probe. Never exposed as MCP tools — these are operator actions,
// not something an AI coding client should be able to call.

export interface AdminContext {
  db: ControllerDatabase;
  identity?: ControllerIdentity;
  connectedAgents?: Map<string, ConnectedAgent>;
}

function requireIdentity(ctx: AdminContext): ControllerIdentity {
  if (!ctx.identity) {
    throw RboError.internal('Controller identity is not initialized');
  }
  return ctx.identity;
}

export async function handleAdminRequest(
  ctx: AdminContext,
  action: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  switch (action) {
    case 'pairing/list': {
      const rawState = args.state;
      const state =
        typeof rawState === 'string' ? (rawState as PairingRequestRow['state']) : undefined;
      return { status: 200, body: { requests: listPairingRequests(ctx.db, state) } };
    }

    case 'pairing/approve': {
      const requestId = String(args.pairing_request_id ?? '');
      const { agentId } = approvePairingRequest(ctx.db, requireIdentity(ctx), requestId);
      return { status: 200, body: { agent_id: agentId } };
    }

    case 'pairing/reject': {
      const requestId = String(args.pairing_request_id ?? '');
      rejectPairingRequest(ctx.db, requestId);
      return { status: 200, body: {} };
    }

    case 'agents/list':
      return { status: 200, body: { agents: listAgents(ctx.db, true) } };

    case 'agents/revoke': {
      const agentId = String(args.agent_id ?? '');
      revokeAgent(ctx.db, agentId);
      return { status: 200, body: {} };
    }

    case 'agents/probe': {
      const agentId = String(args.agent_id ?? '');
      const result = requestAgentProbe(ctx.connectedAgents, agentId);
      if ('error' in result) {
        return { status: 409, body: { error: result.error } };
      }
      return { status: 200, body: result };
    }

    default:
      throw RboError.validation(`Unknown admin action '${action}'`);
  }
}
