import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ArtifactRule, McpToolName, RiskLevel } from '@rbo/protocol';
import { getMcpToolDef, parseJobEventLine } from '@rbo/protocol';
import type { ControllerIdentity, GitUrlAllowlist, StructuredErrorDetails } from '@rbo/shared';
import { RboError } from '@rbo/shared';
import { z } from 'zod';
import { requestAgentProbe } from '../agents/probe.js';
import { listAgents } from '../agents/service.js';
import { materializeArtifactToDestination } from '../execution/artifacts.js';
import { attemptLogDir } from '../execution/runner.js';
import { handleJobRun } from '../jobs/job-run.js';
import type { JobRunOptions } from '../jobs/job-run.js';
import { getAttempt, getJob, getLatestAttempt } from '../jobs/lifecycle.js';
import {
  handleJobArtifacts,
  handleJobCancel,
  handleJobConfirm,
  handleJobSubmit,
  waitForJob,
} from '../jobs/submit.js';
import type { ControllerDatabase } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';
import {
  type LogCursor as PaginationLogCursor,
  decodeCursor as decodeLogCursor,
  encodeCursor as encodeLogCursor,
  readJobLogsPage as readLogPage,
} from './log-pagination.js';

function cursorError(message: string): Record<string, unknown> {
  return { error: { category: 'validation', message, retryable: false } };
}

// Local client identity for audit (§35 Phase 1): who called, over what.
export interface ClientIdentity {
  client_id: string;
  transport: 'http' | 'stdio' | 'internal';
  session_id: string | null;
}

export interface ToolContext {
  db: ControllerDatabase;
  identity: ClientIdentity;
  dataDir: string;
  controllerIdentity?: ControllerIdentity;
  allowedProjectRoots?: string[];
  allowedArtifactDestinations?: string[];
  maxConcurrentJobs?: number;
  connectedAgents?: Map<string, ConnectedAgent>;
  agentPlanePort?: number;
  controllerPublicHost?: string;
  dataPlaneBaseUrl?: string;
  gitAllowlist?: GitUrlAllowlist;
  allowLocalFallback?: boolean;
  allowFullSnapshotFallback?: boolean;
  /** Controller-level queue policy used when a job does not set one explicitly. */
  defaultQueuePolicy?: import('@rbo/protocol').QueuePolicy;
  /** Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md). */
  getHostCpuBusyFraction?: () => number;
  maxHostCpuBusyFraction?: number;
  /** Optional progress sink for job_run (MCP notifications/progress). */
  jobRunOptions?: JobRunOptions;
}

export interface ToolErrorResult {
  error: StructuredErrorDetails;
}

async function readEventsPage(
  path: string,
  cursor: number,
  maxEvents: number,
): Promise<{
  events: Array<{ event: import('@rbo/protocol').JobEvent; line: number }>;
  nextCursor: number;
  scannedLines: number;
}> {
  const events: Array<{ event: import('@rbo/protocol').JobEvent; line: number }> = [];
  let lineIndex = 0;
  const input = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of input) {
      if (lineIndex++ < cursor) continue;
      let event: import('@rbo/protocol').JobEvent | null = null;
      try {
        event = parseJobEventLine(line);
      } catch {
        // Malformed JSONL is treated like a skipped durable line.  The cursor still advances.
      }
      if (event) events.push({ event, line: lineIndex - 1 });
      if (events.length >= maxEvents) break;
    }
  } finally {
    input.close();
  }
  return { events, nextCursor: lineIndex, scannedLines: lineIndex };
}

function runnerContext(ctx: ToolContext) {
  return {
    db: ctx.db,
    dataDir: ctx.dataDir,
    allowedProjectRoots: ctx.allowedProjectRoots ?? [],
    allowedArtifactDestinations: ctx.allowedArtifactDestinations ?? ctx.allowedProjectRoots ?? [],
    maxConcurrentJobs: ctx.maxConcurrentJobs ?? 1,
    gitAllowlist: ctx.gitAllowlist,
  };
}

function submitContext(ctx: ToolContext) {
  if (!ctx.controllerIdentity) {
    throw RboError.internal('Controller identity is not configured');
  }
  return {
    ...runnerContext(ctx),
    clientId: ctx.identity.client_id,
    controllerIdentity: ctx.controllerIdentity,
    connectedAgents: ctx.connectedAgents,
    agentPlanePort: ctx.agentPlanePort,
    controllerPublicHost: ctx.controllerPublicHost,
    dataPlaneBaseUrl: ctx.dataPlaneBaseUrl,
    allowLocalFallback: ctx.allowLocalFallback,
    allowFullSnapshotFallback: ctx.allowFullSnapshotFallback,
    defaultQueuePolicy: ctx.defaultQueuePolicy,
    getHostCpuBusyFraction: ctx.getHostCpuBusyFraction,
    maxHostCpuBusyFraction: ctx.maxHostCpuBusyFraction,
  };
}

// Tools whose backend arrives in a later phase return a schema-valid
// not_implemented response instead of failing the transport (§35 Phase 1).
// (agent_probe wired in §2.7 remediation.)

export function validateToolInput(name: string, args: unknown): Record<string, unknown> {
  const def = getMcpToolDef(name);
  if (!def) {
    throw RboError.validation(`Unknown tool '${name}'`);
  }
  const parsed = (
    name === 'job_logs' ? z.object(def.inputShape).strict() : z.object(def.inputShape)
  ).safeParse(args ?? {});
  if (!parsed.success) {
    throw RboError.validation(`Invalid input for tool '${name}'`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data as Record<string, unknown>;
}

export async function handleToolCall(
  ctx: ToolContext,
  name: McpToolName,
  rawArgs: unknown,
): Promise<Record<string, unknown>> {
  const args = validateToolInput(name, rawArgs);

  switch (name) {
    case 'agents_list':
      return { agents: listAgents(ctx.db, args.include_offline === true) };

    case 'job_submit':
      return handleJobSubmit(submitContext(ctx), args);

    case 'job_run':
      return handleJobRun(
        submitContext(ctx),
        {
          command: args.command as string | undefined,
          project_root: args.project_root as string | undefined,
          job_id: args.job_id as string | undefined,
          cwd: args.cwd as string | undefined,
          timeout_seconds: args.timeout_seconds as number | undefined,
          wait_seconds: args.wait_seconds as number | undefined,
          mcp_wait_slice_seconds: args.mcp_wait_slice_seconds as number | undefined,
          artifacts: args.artifacts as ArtifactRule[] | undefined,
          risk_level: args.risk_level as RiskLevel | undefined,
          client_request_id: args.client_request_id as string | undefined,
          name: args.name as string | undefined,
          log_cursor: args.log_cursor as string | null | undefined,
          max_output_bytes: args.max_output_bytes as number | undefined,
        },
        ctx.jobRunOptions,
      );

    case 'job_confirm':
      return handleJobConfirm(submitContext(ctx), {
        job_id: args.job_id as string,
        confirmation_token: args.confirmation_token as string,
      });

    case 'job_get': {
      const job = getJob(ctx.db, args.job_id as string);
      if (!job) {
        return {
          error: {
            category: 'validation',
            message: `Unknown job_id '${args.job_id}'`,
            retryable: false,
          } satisfies StructuredErrorDetails,
        };
      }
      return { job };
    }

    case 'job_wait':
      return waitForJob(runnerContext(ctx), args.job_id as string, args.wait_seconds as number, {
        includeLogTailLines: args.include_log_tail_lines as number,
      });

    case 'job_logs': {
      const job = getJob(ctx.db, args.job_id as string);
      if (!job) {
        return {
          error: {
            category: 'validation',
            message: `Unknown job_id '${args.job_id}'`,
            retryable: false,
          },
        };
      }
      const mode = args.mode as 'logs' | 'events';
      if (!ctx.controllerIdentity) return cursorError('Controller identity is not configured');
      const supplied = args.cursor as string | null;
      const decoded = supplied ? decodeLogCursor(ctx.controllerIdentity, supplied) : null;
      if (supplied && !decoded) return cursorError('Invalid or expired job_logs cursor');
      if (decoded && args.attempt_id && args.attempt_id !== decoded.attempt)
        return cursorError('Cursor does not match requested attempt');
      const attemptId =
        decoded?.attempt ??
        (args.attempt_id as string | null) ??
        getLatestAttempt(ctx.db, job.id)?.id ??
        null;
      if (!attemptId) {
        return {
          error: {
            category: 'validation',
            message: 'No attempt found for job',
            retryable: false,
          },
        };
      }
      let cursor: PaginationLogCursor;
      if (decoded) {
        if (decoded.job !== job.id || decoded.attempt !== attemptId || decoded.mode !== mode) {
          return cursorError('Cursor does not match job, attempt, or mode');
        }
        cursor = decoded;
      } else {
        cursor = {
          v: 1,
          job: job.id,
          attempt: attemptId,
          mode,
          seq: 0,
          off: 0,
          profile: 'ansi-v1',
        };
      }
      const attempt = getAttempt(ctx.db, attemptId);
      if (!attempt || attempt.job_id !== job.id)
        return cursorError('Attempt does not belong to job');
      const logDir = attemptLogDir(ctx.dataDir, attemptId);
      const logs = {
        logDir,
        stdoutPath: join(logDir, 'stdout.log'),
        stderrPath: join(logDir, 'stderr.log'),
        eventsPath: join(logDir, 'events.jsonl'),
        chunksPath: join(logDir, 'chunks.jsonl'),
      };
      const maxBytes = args.max_bytes as number;
      if (mode === 'events') {
        const eventLimit = Math.max(1, Math.floor(maxBytes / 256));
        let events: Awaited<ReturnType<typeof readEventsPage>>;
        try {
          events = await readEventsPage(logs.eventsPath, cursor.seq, eventLimit + 1);
        } catch {
          return cursorError('Unable to read durable job events');
        }
        const selected = [];
        let returned = 0;
        let nextLine = cursor.seq;
        for (const item of events.events) {
          const bytes = Buffer.byteLength(JSON.stringify(item.event), 'utf8');
          if (selected.length > 0 && returned + bytes > maxBytes) break;
          if (selected.length === 0 && bytes > maxBytes) {
            return cursorError(
              `A single job event exceeds max_bytes (${bytes} > ${maxBytes}); increase max_bytes${maxBytes >= 1024 * 1024 ? ' but it cannot be returned under the current cap' : ''}`,
            );
          }
          selected.push(item.event);
          returned += bytes;
          nextLine = item.line + 1;
        }
        // Advance over malformed lines even when a page contains no valid event.  Otherwise a
        // corrupt JSONL record would permanently livelock the caller at the same cursor.
        const next = {
          ...cursor,
          seq:
            selected.length > 0
              ? nextLine
              : events.scannedLines > cursor.seq
                ? events.scannedLines
                : cursor.seq,
          off: 0,
        };
        const nextCursor = encodeLogCursor(ctx.controllerIdentity, next);
        const advanced = next.seq !== cursor.seq;
        if (advanced && !nextCursor)
          return cursorError('job_logs cursor cannot be represented within 512 bytes');
        return {
          job_id: job.id,
          attempt_id: attemptId,
          mode,
          events: selected,
          next_cursor: advanced ? nextCursor : supplied,
          returned_bytes: returned,
          has_more: selected.length < events.events.length || events.events.length > eventLimit,
          truncated: selected.length === 0 && events.events.length > 0,
        };
      }
      let page: Awaited<ReturnType<typeof readLogPage>>;
      try {
        page = await readLogPage(logs, cursor, maxBytes);
      } catch {
        return cursorError('Unable to read durable job logs');
      }
      const nextCursor =
        page.chunks.length || page.next.seq !== cursor.seq || page.next.off !== cursor.off
          ? encodeLogCursor(ctx.controllerIdentity, page.next)
          : supplied;
      if (page.chunks.length && !nextCursor)
        return cursorError('job_logs cursor cannot be represented within 512 bytes');
      return {
        job_id: job.id,
        attempt_id: attemptId,
        mode,
        chunks: page.chunks,
        next_cursor: nextCursor,
        returned_bytes: page.returned,
        has_more: page.hasMore,
        truncated: page.truncated,
      };
    }

    case 'job_cancel':
      return handleJobCancel(
        { ...runnerContext(ctx), connectedAgents: ctx.connectedAgents },
        args.job_id as string,
        args.reason as string | undefined,
      );

    case 'job_artifacts':
      return handleJobArtifacts(ctx.db, args.job_id as string);

    case 'artifact_materialize':
      try {
        const result = await materializeArtifactToDestination({
          db: ctx.db,
          artifactId: args.artifact_id as string,
          destinationPath: args.destination_path as string,
          allowedDestinations: ctx.allowedArtifactDestinations ?? ctx.allowedProjectRoots ?? [],
          overwrite: args.overwrite === true,
          clientId: ctx.identity.client_id,
          dataDir: ctx.dataDir,
        });
        return { artifact_id: args.artifact_id, ...result };
      } catch (error) {
        return {
          error: {
            category: 'materialization',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
      }

    case 'agent_probe': {
      const result = requestAgentProbe(ctx.connectedAgents, args.agent_id as string);
      if ('error' in result) {
        return { error: result.error };
      }
      return result;
    }
  }
}
