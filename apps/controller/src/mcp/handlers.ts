import { join } from 'node:path';
import { readEventsFromCursor, readLogsFromCursor } from '@rbo/executor';
import type { ArtifactRule, McpToolName, RiskLevel } from '@rbo/protocol';
import { getMcpToolDef } from '@rbo/protocol';
import type { ControllerIdentity, GitUrlAllowlist, StructuredErrorDetails } from '@rbo/shared';
import { RboError } from '@rbo/shared';
import { z } from 'zod';
import { requestAgentProbe } from '../agents/probe.js';
import { listAgents } from '../agents/service.js';
import { materializeArtifactToDestination } from '../execution/artifacts.js';
import { attemptLogDir } from '../execution/runner.js';
import { handleJobRun } from '../jobs/job-run.js';
import type { JobRunOptions } from '../jobs/job-run.js';
import { getJob, getLatestAttempt } from '../jobs/lifecycle.js';
import {
  handleJobArtifacts,
  handleJobCancel,
  handleJobConfirm,
  handleJobSubmit,
  waitForJob,
} from '../jobs/submit.js';
import type { ControllerDatabase } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';

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
  /** Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md). */
  getHostCpuBusyFraction?: () => number;
  maxHostCpuBusyFraction?: number;
  /** Optional progress sink for job_run (MCP notifications/progress). */
  jobRunOptions?: JobRunOptions;
}

export interface ToolErrorResult {
  error: StructuredErrorDetails;
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
  const parsed = z.object(def.inputShape).safeParse(args ?? {});
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
          include_log_tail_lines: args.include_log_tail_lines as number | undefined,
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
      return waitForJob(
        runnerContext(ctx),
        args.job_id as string,
        args.wait_seconds as number,
        args.include_log_tail_lines as number,
      );

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
      const attemptId =
        (args.attempt_id as string | null) ?? getLatestAttempt(ctx.db, job.id)?.id ?? null;
      if (!attemptId) {
        return {
          error: {
            category: 'validation',
            message: 'No attempt found for job',
            retryable: false,
          },
        };
      }
      const logDir = attemptLogDir(ctx.dataDir, attemptId);
      const logs = {
        logDir,
        stdoutPath: join(logDir, 'stdout.log'),
        stderrPath: join(logDir, 'stderr.log'),
        eventsPath: join(logDir, 'events.jsonl'),
        chunksPath: join(logDir, 'chunks.jsonl'),
      };
      const streams = args.streams as Array<'stdout' | 'stderr' | 'events'>;
      const response: Record<string, unknown> = { job_id: job.id, attempt_id: attemptId };

      if (streams.includes('events')) {
        const maxEvents = Math.max(1, Math.floor((args.max_bytes as number) / 256));
        const events = await readEventsFromCursor(logs, args.cursor as number, maxEvents);
        response.events = events.events;
        response.next_cursor = events.nextCursor;
      } else {
        const chunk = await readLogsFromCursor(
          logs,
          args.cursor as number,
          args.max_bytes as number,
          streams.filter((s): s is 'stdout' | 'stderr' => s !== 'events'),
        );
        response.data = chunk.data;
        response.next_cursor = chunk.nextCursor;
      }
      return response;
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
