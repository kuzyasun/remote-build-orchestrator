import { createInterface } from 'node:readline/promises';
import { sanitizeTerminalOutput } from './agent.js';

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

export interface PromptPairingOptions {
  isTTY?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signal?: AbortSignal;
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
 * Fetch pending pairing requests from the Controller.
 */
export async function listPendingPairingsRemote(baseUrl: string): Promise<PendingPairingSummary[]> {
  const pairingResult = await postAdmin<{ requests: PendingPairingSummary[] }>(
    baseUrl,
    'pairing/list',
    { state: 'pending' },
  );
  return pairingResult.requests.map((row) => ({
    id: row.id,
    display_name: row.display_name,
    hostname: row.hostname,
    state: row.state,
    one_time_code: row.one_time_code,
    expires_at: row.expires_at,
  }));
}

/**
 * Format the list of pending pairing requests for interactive selection.
 */
export function formatPendingPairingsList(requests: PendingPairingSummary[]): string {
  if (requests.length === 0) {
    return '';
  }
  const lines: string[] = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const safeName = sanitizeTerminalOutput(req.display_name);
    const hostInfo = req.hostname ? ` (hostname: ${sanitizeTerminalOutput(req.hostname)})` : '';
    const safeId = sanitizeTerminalOutput(req.id);
    const safeCode = sanitizeTerminalOutput(req.one_time_code);
    lines.push(`  ${i + 1}) ${safeName}${hostInfo}`);
    lines.push(`     ID: ${safeId}  code: ${safeCode}`);
  }
  lines.push('  0) Cancel');
  return lines.join('\n');
}

/**
 * Interactively prompt the operator to select a pending pairing request.
 * Returns the selected pairing request, or null if cancelled or non-TTY.
 */
export async function promptPendingPairingSelection(
  baseUrl: string,
  actionLabel: 'approve' | 'reject',
  options: PromptPairingOptions = {},
): Promise<PendingPairingSummary | null> {
  const pending = await listPendingPairingsRemote(baseUrl);
  if (pending.length === 0) {
    console.error('No pending pairing requests found.');
    return null;
  }

  const isTTY =
    options.isTTY ??
    Boolean((options.input as { isTTY?: boolean } | undefined)?.isTTY ?? process.stdin.isTTY);
  if (!isTTY) {
    console.error(
      `Non-interactive terminal detected. Specify the pairing request ID explicitly: rbo agent ${actionLabel} <pairing-request-id>`,
    );
    return null;
  }

  const noun = pending.length === 1 ? 'request' : 'requests';
  console.error(`\nFound ${pending.length} pending pairing ${noun}:`);
  console.error(formatPendingPairingsList(pending));

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      ac.abort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stderr,
  });
  rl.on('SIGINT', onAbort);

  const onSigint = () => ac.abort();
  const customInput =
    options.input && options.input !== process.stdin
      ? (options.input as NodeJS.EventEmitter)
      : null;
  if (customInput) {
    customInput.on('SIGINT', onSigint);
  }

  try {
    const max = pending.length;
    const defaultChoice = max === 1 ? '1' : undefined;
    const promptSuffix = max === 1 ? '[1, 0 to cancel] (default 1): ' : `[1-${max}, 0 to cancel]: `;
    const answer = await rl.question(`\nSelect pairing request to ${actionLabel} ${promptSuffix}`, {
      signal: ac.signal,
    });
    const trimmed = answer.trim() || (defaultChoice ?? '');
    if (!/^\d+$/.test(trimmed)) {
      console.error('Invalid selection — cancelled.');
      return null;
    }
    const num = Number.parseInt(trimmed, 10);
    if (num < 0 || num > max) {
      console.error('Invalid selection — cancelled.');
      return null;
    }
    if (num === 0) {
      return null;
    }
    return pending[num - 1];
  } catch (error) {
    if (
      ac.signal.aborted ||
      options.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new Error(`Pairing ${actionLabel} cancelled by operator`);
    }
    return null;
  } finally {
    rl.close();
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    if (customInput) {
      customInput.off('SIGINT', onSigint);
    }
  }
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
  const [agentsResult, pending_pairings] = await Promise.all([
    postAdmin<{ agents: AgentSummary[] }>(baseUrl, 'agents/list', {}),
    listPendingPairingsRemote(baseUrl),
  ]);
  return {
    agents: agentsResult.agents,
    pending_pairings,
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
