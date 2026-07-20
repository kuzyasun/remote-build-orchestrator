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

export function getJobLogsRemote(
  baseUrl: string,
  jobId: string,
  options?: { attempt_id?: string; streams?: string[]; max_bytes?: number; cursor?: number },
): Promise<Record<string, unknown>> {
  return postTool(baseUrl, 'job_logs', {
    job_id: jobId,
    attempt_id: options?.attempt_id ?? null,
    streams: options?.streams ?? ['stdout', 'stderr', 'events'],
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
