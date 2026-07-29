// Thin HTTP client for Controller job MCP tools via /internal/v1/tools/* (§23).

async function postTool<T>(baseUrl: string, tool: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/internal/v1/tools/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rbo-client-id': process.env.RBO_CLIENT_ID ?? 'rbo-cli',
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { error?: { category: string; message: string } };
  if (!res.ok) {
    const err = json.error;
    throw new Error(err ? `${err.category}: ${err.message}` : `HTTP ${res.status}`);
  }
  if (json.error) {
    throw new Error(`${json.error.category}: ${json.error.message}`);
  }
  return json as T;
}

export function submitJobRemote(
  baseUrl: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_submit', request);
}

export function getJobRemote(baseUrl: string, jobId: string): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_get', { job_id: jobId });
}

/** `job_get` returns `{ job: { state, ... } }` — not a flat job object. */
function jobStateFromGet(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) {
    return undefined;
  }
  const nested = payload.job;
  if (nested && typeof nested === 'object' && nested !== null && 'state' in nested) {
    const state = (nested as { state: unknown }).state;
    return typeof state === 'string' ? state : undefined;
  }
  return undefined;
}

export function getJobLogsRemote(
  baseUrl: string,
  jobId: string,
  options?: {
    attempt_id?: string;
    streams?: Array<'stdout' | 'stderr' | 'events'>;
    max_bytes?: number;
    cursor?: number;
  },
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_logs', {
    job_id: jobId,
    attempt_id: options?.attempt_id ?? null,
    // Default stdout/stderr only — including events switches the response shape.
    streams: options?.streams ?? ['stdout', 'stderr'],
    max_bytes: options?.max_bytes ?? 65_536,
    cursor: options?.cursor ?? 0,
  });
}

export function cancelJobRemote(
  baseUrl: string,
  jobId: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_cancel', { job_id: jobId, reason });
}

export interface FollowLogsOptions {
  attemptId?: string;
  /** Called with each log chunk; defaults to writing stdout/stderr. */
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Abort signal / stop predicate. */
  signal?: AbortSignal;
  /** Poll interval for job terminal state (ms). */
  pollMs?: number;
}

const TERMINAL_JOB_STATES = new Set(['completed']);

function isTerminalState(state: unknown): boolean {
  return typeof state === 'string' && TERMINAL_JOB_STATES.has(state);
}

function writeChunkDefault(stream: 'stdout' | 'stderr', text: string): void {
  if (stream === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
}

/**
 * Historical + live SSE follow. Reconnects with Last-Event-ID to avoid
 * duplicate output. Exits after the stream emits `done`, or after a capped
 * catch-up reconnect budget once the job is already terminal.
 */
export async function followJobLogsRemote(
  baseUrl: string,
  jobId: string,
  options: FollowLogsOptions = {},
): Promise<{ lastSequence: number; state: string | null }> {
  const root = baseUrl.replace(/\/+$/, '');
  const onChunk = options.onChunk ?? writeChunkDefault;
  const pollMs = options.pollMs ?? 500;
  let lastSequence = 0;
  let lastState: string | null = null;

  const buildUrl = (): string => {
    const url = new URL(`${root}/internal/v1/jobs/${encodeURIComponent(jobId)}/logs/stream`);
    if (options.attemptId) {
      url.searchParams.set('attempt_id', options.attemptId);
    }
    if (lastSequence > 0) {
      url.searchParams.set('after_sequence', String(lastSequence));
    }
    return url.toString();
  };

  const parseSseBlocks = async function* (
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<{ id?: string; event?: string; data: string }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let splitAt = buffer.indexOf('\n\n');
      while (splitAt >= 0) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const lines = raw.split(/\r?\n/);
        let id: string | undefined;
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('id:')) {
            id = line.slice(3).trim();
          } else if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          yield { id, event, data: dataLines.join('\n') };
        }
        splitAt = buffer.indexOf('\n\n');
      }
    }
  };

  // Keep reconnecting until `done`, abort, or capped catch-up after terminal.
  // Terminal job_get alone is not enough — reconnect with Last-Event-ID for the tail.
  let terminalCatchUpAttempts = 0;
  const maxTerminalCatchUpAttempts = 5;

  while (!options.signal?.aborted) {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'x-rbo-client-id': process.env.RBO_CLIENT_ID ?? 'rbo-cli',
    };
    if (lastSequence > 0) {
      headers['last-event-id'] = String(lastSequence);
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(), { headers, signal: options.signal });
    } catch {
      if (options.signal?.aborted) {
        break;
      }
      const payload = await getJobRemote(root, jobId).catch(() => null);
      const state = jobStateFromGet(payload);
      lastState = state ?? lastState;
      if (state && isTerminalState(state)) {
        terminalCatchUpAttempts += 1;
        if (terminalCatchUpAttempts > maxTerminalCatchUpAttempts) {
          break;
        }
      } else {
        terminalCatchUpAttempts = 0;
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      // Attempt may not exist yet (queued) — validation 400 is retryable.
      if (res.status === 400 || res.status === 404) {
        const payload = await getJobRemote(root, jobId).catch(() => null);
        const state = jobStateFromGet(payload);
        lastState = state ?? lastState;
        if (!payload || !state) {
          throw new Error(`log stream failed: HTTP ${res.status} ${text}`);
        }
        if (isTerminalState(state)) {
          terminalCatchUpAttempts += 1;
          if (terminalCatchUpAttempts > maxTerminalCatchUpAttempts) {
            break;
          }
        } else {
          terminalCatchUpAttempts = 0;
        }
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      throw new Error(`log stream failed: HTTP ${res.status} ${text}`);
    }

    let finished = false;
    const sequenceBefore = lastSequence;
    for await (const block of parseSseBlocks(res.body)) {
      if (options.signal?.aborted) {
        finished = true;
        break;
      }
      if (block.event === 'heartbeat') {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(block.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (block.event === 'done') {
        lastState = typeof parsed.state === 'string' ? parsed.state : lastState;
        if (typeof parsed.last_sequence === 'number') {
          lastSequence = Math.max(lastSequence, parsed.last_sequence);
        }
        finished = true;
        break;
      }
      if (block.event === 'error') {
        // e.g. buffer_overflow — end stream so we reconnect with Last-Event-ID.
        if (typeof parsed.last_sequence === 'number') {
          lastSequence = Math.max(lastSequence, parsed.last_sequence);
        }
        break;
      }
      if (block.event === 'log' || typeof parsed.sequence === 'number') {
        const sequence = Number(parsed.sequence);
        const stream = parsed.stream === 'stderr' ? 'stderr' : 'stdout';
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        if (Number.isFinite(sequence) && sequence > lastSequence) {
          lastSequence = sequence;
          if (text.length > 0) {
            onChunk(stream, text);
          }
        }
      }
    }

    if (finished) {
      break;
    }

    const payload = await getJobRemote(root, jobId).catch(() => null);
    const state = jobStateFromGet(payload);
    lastState = state ?? lastState;
    if (state && isTerminalState(state)) {
      // Progress on catch-up resets the budget; idle reconnects burn it.
      if (lastSequence > sequenceBefore) {
        terminalCatchUpAttempts = 0;
      } else {
        terminalCatchUpAttempts += 1;
      }
      if (terminalCatchUpAttempts > maxTerminalCatchUpAttempts) {
        break;
      }
    } else {
      terminalCatchUpAttempts = 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return { lastSequence, state: lastState };
}
