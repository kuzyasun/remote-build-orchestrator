import type { McpToolName } from '@rbo/protocol';
import { getMcpToolDef } from '@rbo/protocol';
import type { StructuredErrorDetails } from '@rbo/shared';
import { RboError } from '@rbo/shared';
import { z } from 'zod';
import { listAgents } from '../agents/service.js';
import { getJob } from '../jobs/service.js';
import type { ControllerDatabase } from '../storage/database.js';

// Local client identity for audit (§35 Phase 1): who called, over what.
export interface ClientIdentity {
  client_id: string;
  transport: 'http' | 'stdio' | 'internal';
  session_id: string | null;
}

export interface ToolContext {
  db: ControllerDatabase;
  identity: ClientIdentity;
}

export interface ToolErrorResult {
  error: StructuredErrorDetails;
}

// Tools whose backend arrives in a later phase return a schema-valid
// not_implemented response instead of failing the transport (§35 Phase 1).
function notImplemented(tool: McpToolName, plannedPhase: number): ToolErrorResult {
  return {
    error: {
      category: 'internal',
      message: `not_implemented: '${tool}' becomes available in Phase ${plannedPhase}`,
      retryable: false,
      details: { not_implemented: true, planned_phase: plannedPhase },
    },
  };
}

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
    case 'job_logs':
    case 'job_cancel':
    case 'job_artifacts':
    case 'artifact_materialize':
      return { ...notImplemented(name, 3) };

    case 'agent_probe':
      return { ...notImplemented(name, 2) };
  }
}
