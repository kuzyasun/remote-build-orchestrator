import type { JobRunInput } from './run.js';

// Thin HTTP client for Controller job MCP tools via /internal/v1/tools/* (§23).

const TOOL_REQUEST_TIMEOUT_MS = 15_000;
/** `mcp_wait_slice_seconds` max is 55s; include HTTP headroom for resume waits. */
export const JOB_RUN_WAIT_TIMEOUT_MS = 70_000;
/** Snapshot capture bound for `job_submit`. */
export const JOB_SUBMIT_TIMEOUT_MS = 120_000;
/** First `job_run` includes snapshot capture and then a wait slice. */
export const JOB_RUN_INITIAL_TIMEOUT_MS = JOB_SUBMIT_TIMEOUT_MS + JOB_RUN_WAIT_TIMEOUT_MS;

export interface ToolCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function postTool<T>(
  baseUrl: string,
  tool: string,
  body: unknown,
  options?: ToolCallOptions,
): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/internal/v1/tools/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rbo-client-id': process.env.RBO_CLIENT_ID ?? 'rbo-cli',
    },
    body: JSON.stringify(body ?? {}),
    // Each request is bounded; resume polling itself intentionally has no total job deadline.
    signal: options?.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.timeoutMs ?? TOOL_REQUEST_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(options?.timeoutMs ?? TOOL_REQUEST_TIMEOUT_MS),
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
  return postTool(baseUrl, 'job_submit', request, { timeoutMs: JOB_SUBMIT_TIMEOUT_MS });
}

/** Submit the shared compact `job_run` input without local protocol revalidation. */
export function runJobRemote(
  baseUrl: string,
  input: JobRunInput,
  options?: ToolCallOptions,
): Promise<Record<string, unknown>> {
  const hasJobId = typeof input.job_id === 'string' && input.job_id.length > 0;
  return postTool(baseUrl, 'job_run', input, {
    ...options,
    timeoutMs:
      options?.timeoutMs ?? (hasJobId ? JOB_RUN_WAIT_TIMEOUT_MS : JOB_RUN_INITIAL_TIMEOUT_MS),
  });
}

/** Confirm a previously captured destructive or hardware job. */
export function confirmJobRemote(
  baseUrl: string,
  jobId: string,
  confirmationToken: string,
  options?: ToolCallOptions,
): Promise<Record<string, unknown>> {
  return postTool(
    baseUrl,
    'job_confirm',
    {
      job_id: jobId,
      confirmation_token: confirmationToken,
    },
    options,
  );
}

export function getJobRemote(
  baseUrl: string,
  jobId: string,
  options?: ToolCallOptions,
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_get', { job_id: jobId }, options);
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
    mode?: 'logs' | 'events';
    max_bytes?: number;
    cursor?: string | null;
  },
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_logs', {
    job_id: jobId,
    attempt_id: options?.attempt_id ?? null,
    mode: options?.mode ?? 'logs',
    max_bytes: options?.max_bytes ?? 65_536,
    cursor: options?.cursor ?? null,
  });
}

export function cancelJobRemote(
  baseUrl: string,
  jobId: string,
  reason?: string,
  options?: ToolCallOptions,
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_cancel', { job_id: jobId, reason }, options);
}

export interface FollowLogsOptions {
  attemptId?: string;
  /** Called with each log chunk; defaults to writing stdout/stderr. */
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Abort signal / stop predicate. */
  signal?: AbortSignal;
  /** Poll interval for job terminal state (ms). */
  pollMs?: number;
  /** Bound one SSE connection attempt; an established live stream is not timed out. */
  connectTimeoutMs?: number;
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
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
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
    const connectAbort = new AbortController();
    const timeout = setTimeout(() => connectAbort.abort(), connectTimeoutMs);
    try {
      const signal = options.signal
        ? AbortSignal.any([options.signal, connectAbort.signal])
        : connectAbort.signal;
      res = await fetch(buildUrl(), { headers, signal });
    } catch {
      if (options.signal?.aborted) {
        break;
      }
      const payload = await getJobRemote(root, jobId, { signal: options.signal }).catch(() => null);
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
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      // Attempt may not exist yet (queued) — validation 400 is retryable.
      if (res.status === 400 || res.status === 404) {
        const payload = await getJobRemote(root, jobId, { signal: options.signal }).catch(
          () => null,
        );
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

    const payload = await getJobRemote(root, jobId, { signal: options.signal }).catch(() => null);
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
