import type { JobRequest } from '@rbo/protocol';
import {
  type CompatibilityCell,
  CompatibilityCellSchema,
  type CompatibilityMatrix,
  CompatibilityMatrixSchema,
  JobRequestSchema,
} from '@rbo/protocol';

export {
  CompatibilityCellSchema,
  CompatibilityMatrixSchema,
  type CompatibilityCell,
  type CompatibilityMatrix,
};

/** Minimal MCP client surface used by Phase 8 smoke helpers. */
export interface Phase8McpClient {
  callTool(args: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
}

export function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (!first || first.type !== 'text') {
    throw new Error('expected text content');
  }
  return first.text;
}

export function baseSmokeJobRequest(
  projectRoot: string,
  overrides?: Partial<JobRequest>,
): JobRequest {
  const script =
    process.platform === 'win32'
      ? 'Write-Output "phase8-smoke"; Set-Content -Path out.txt -Value "phase8-artifact"'
      : 'echo phase8-smoke\nprintf phase8-artifact > out.txt';
  return JobRequestSchema.parse({
    client_request_id: `phase8-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'phase8-smoke',
    source: { project_root: projectRoot, cwd: '.' },
    execution: {
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      script,
      timeout_seconds: 60,
      cancel_grace_seconds: 2,
    },
    risk_level: 'safe',
    artifacts: [{ glob: 'out.txt', required: true }],
    ...overrides,
  });
}

export function longRunningCancelJobRequest(projectRoot: string): JobRequest {
  const sleepScript = process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60';
  return JobRequestSchema.parse({
    ...baseSmokeJobRequest(projectRoot),
    client_request_id: `phase8-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'phase8-cancel',
    execution: {
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      script: sleepScript,
      timeout_seconds: 120,
      cancel_grace_seconds: 2,
    },
    artifacts: [],
  });
}

export interface Phase8SmokeTranscriptEntry {
  at: string;
  tool: string;
  request_summary: string;
  response_summary: string;
}

export interface Phase8SmokeResult {
  jobId: string;
  attemptId: string | null;
  artifactIds: string[];
  logBytes: number;
  transcript: Phase8SmokeTranscriptEntry[];
}

export interface Phase8SmokeOptions {
  waitSeconds?: number;
  artifactDestPath?: string;
  overwriteArtifact?: boolean;
}

/** Truncate + strip anything that could carry a secret/credential before it lands in a transcript. */
function summarize(value: unknown): string {
  const text = JSON.stringify(value);
  const redacted = text
    .replace(/"(authorization|token|secret|password|private_key)":"[^"]*"/gi, '"$1":"[REDACTED]"')
    // Whole quoted string values containing a developer-machine home path — match through to the
    // closing quote (not just past the next single/doubled backslash) since JSON-escaping renders
    // each path separator as `\\` (two characters), which a naive single-backslash pattern misses.
    .replace(/"[^"]*[A-Za-z]:\\{1,2}Users\\{1,2}[^"]*"/gi, '"[REDACTED_PATH]"')
    .replace(/"[^"]*\/(?:home|Users)\/[^"]*"/g, '"[REDACTED_PATH]"');
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

/**
 * Canonical Phase 8 smoke workflow: submit → wait → logs → artifacts → optional materialize.
 * Records a real, redacted request/response transcript for in-memory / temp-dir assertions.
 * Do not write per-run transcripts into tracked docs/compatibility/evidence/ (those files
 * are stable committed pointers; product-client evidence is recorded manually).
 */
export async function runPhase8SmokeWorkflow(
  client: Phase8McpClient,
  projectRoot: string,
  options: Phase8SmokeOptions = {},
): Promise<Phase8SmokeResult> {
  const waitSeconds = options.waitSeconds ?? 60;
  const transcript: Phase8SmokeTranscriptEntry[] = [];
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const raw = await client.callTool({ name, arguments: args });
    const parsed = JSON.parse(textOf(raw));
    transcript.push({
      at: new Date().toISOString(),
      tool: name,
      request_summary: summarize(args),
      response_summary: summarize(parsed),
    });
    return parsed;
  }

  const request = baseSmokeJobRequest(projectRoot);
  const submit = (await call('job_submit', request as unknown as Record<string, unknown>)) as {
    job_id?: string;
    error?: unknown;
  };
  if (!submit.job_id) {
    throw new Error(`job_submit failed: ${JSON.stringify(submit)}`);
  }
  const jobId = submit.job_id;

  const waited = (await call('job_wait', {
    job_id: jobId,
    wait_seconds: waitSeconds,
    include_log_tail_lines: 20,
  })) as { job?: { state?: string; outcome?: string } };
  if (waited.job?.state !== 'completed' || waited.job?.outcome !== 'succeeded') {
    throw new Error(`job_wait unexpected: ${JSON.stringify(waited)}`);
  }

  const logs = (await call('job_logs', {
    job_id: jobId,
    attempt_id: null,
    cursor: null,
    mode: 'logs',
    max_bytes: 65536,
  })) as {
    attempt_id?: string | null;
    next_cursor?: string | null;
    returned_bytes?: number;
    chunks?: unknown[];
  };

  const artifacts = (await call('job_artifacts', { job_id: jobId })) as {
    artifacts?: Array<{ id: string; artifact_id?: string }>;
  };
  const artifactIds = (artifacts.artifacts ?? []).map((a) => a.id ?? a.artifact_id ?? '');
  if (artifactIds.some((id) => !id)) {
    throw new Error(`job_artifacts missing id: ${JSON.stringify(artifacts)}`);
  }

  if (options.artifactDestPath && artifactIds[0]) {
    const materialized = (await call('artifact_materialize', {
      artifact_id: artifactIds[0],
      destination_path: options.artifactDestPath,
      overwrite: options.overwriteArtifact ?? false,
    })) as { error?: unknown; destination_path?: string };
    if (materialized.error) {
      throw new Error(`artifact_materialize failed: ${JSON.stringify(materialized)}`);
    }
  }

  return {
    jobId,
    attemptId: logs.attempt_id ?? null,
    artifactIds,
    logBytes: typeof logs.returned_bytes === 'number' ? logs.returned_bytes : 0,
    transcript,
  };
}

/** Render a captured transcript as markdown (for tests / manual recording — not auto-committed). */
export function renderSmokeEvidence(transport: string, result: Phase8SmokeResult): string {
  const lines = [
    `# Evidence: test-mcp-client / ${transport}`,
    '',
    '- client: test-mcp-client (Vitest MCP SDK harness)',
    `- transport: ${transport}`,
    '- workflow: submit → wait → logs → artifacts → materialize',
    `- job_id: ${result.jobId}`,
    `- attempt_id: ${result.attemptId ?? 'n/a'}`,
    `- artifact_ids: ${result.artifactIds.join(', ') || 'none'}`,
    '- known limitation: not a Codex/Claude/Cursor/Antigravity UI client',
    '',
    '## Raw call transcript (this run, redacted)',
    '',
  ];
  for (const entry of result.transcript) {
    lines.push(`### ${entry.at} — ${entry.tool}`);
    lines.push('');
    lines.push(`- request: \`${entry.request_summary}\``);
    lines.push(`- response: \`${entry.response_summary}\``);
    lines.push('');
  }
  return lines.join('\n');
}
