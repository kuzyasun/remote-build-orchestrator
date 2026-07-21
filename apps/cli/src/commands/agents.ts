// Thin HTTP client for the Controller's local admin API (§33, Phase 2).
// The CLI never touches the database or security modules directly — it talks
// to the loopback Controller exactly like the MCP stdio adapter does, just
// against /internal/v1/admin/* instead of /internal/v1/tools/*.

export interface AgentSummary {
  id: string;
  name: string;
  state: string;
  os: string | null;
  arch: string | null;
  priority: number;
  running_jobs: number;
  max_jobs: number;
  tools: Record<string, string[]>;
}

/** Pending (or otherwise listed) pairing request — id is what `rbo agent approve` takes. */
export interface PendingPairingSummary {
  id: string;
  display_name: string;
  hostname: string | null;
  state: string;
  one_time_code: string;
  expires_at: string;
}

async function postAdmin<T>(baseUrl: string, action: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/internal/v1/admin/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { error?: { category: string; message: string } };
  if (!res.ok) {
    const err = json.error;
    throw new Error(err ? `${err.category}: ${err.message}` : `HTTP ${res.status}`);
  }
  return json as T;
}

/**
 * Fleet view for `rbo agents`: registered agents plus pending pairing requests.
 * Pending rows live in `pairing_requests`, not `agents` — without this join the
 * CLI prints `[]` while an Agent is sitting in pairing_pending (docs expect them
 * to show up here so the operator can copy the id into `rbo agent approve`).
 */
export async function listAgentsRemote(baseUrl: string): Promise<{
  agents: AgentSummary[];
  pending_pairings: PendingPairingSummary[];
}> {
  const [agentsResult, pairingResult] = await Promise.all([
    postAdmin<{ agents: AgentSummary[] }>(baseUrl, 'agents/list', {}),
    postAdmin<{ requests: PendingPairingSummary[] }>(baseUrl, 'pairing/list', {
      state: 'pending',
    }),
  ]);
  return {
    agents: agentsResult.agents,
    pending_pairings: pairingResult.requests.map((row) => ({
      id: row.id,
      display_name: row.display_name,
      hostname: row.hostname,
      state: row.state,
      one_time_code: row.one_time_code,
      expires_at: row.expires_at,
    })),
  };
}

export function approveAgentRemote(
  baseUrl: string,
  pairingRequestId: string,
): Promise<{ agent_id: string }> {
  return postAdmin(baseUrl, 'pairing/approve', { pairing_request_id: pairingRequestId });
}

export function rejectPairingRemote(baseUrl: string, pairingRequestId: string): Promise<object> {
  return postAdmin(baseUrl, 'pairing/reject', { pairing_request_id: pairingRequestId });
}

export function revokeAgentRemote(baseUrl: string, agentId: string): Promise<object> {
  return postAdmin(baseUrl, 'agents/revoke', { agent_id: agentId });
}

export function probeAgentRemote(baseUrl: string, agentId: string): Promise<{ requested: true }> {
  return postAdmin(baseUrl, 'agents/probe', { agent_id: agentId });
}

export function listPairingRequestsRemote(baseUrl: string): Promise<{ requests: unknown[] }> {
  return postAdmin(baseUrl, 'pairing/list', {});
}
