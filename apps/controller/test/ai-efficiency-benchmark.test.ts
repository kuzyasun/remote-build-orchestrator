import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendIndexedLogChunk, ensureAttemptLogs } from '@rbo/executor';
import { ensureControllerIdentity } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { attemptLogDir } from '../src/execution/runner.js';
import { type ToolContext, handleToolCall } from '../src/mcp/handlers.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

const COMPARISON = {
  mode: 'head_only',
  baseline_available: false,
  historical_delta_available: false,
  reason: 'The removed hand-authored response fixture is not a reproducible pre-refactor baseline.',
} as const;

function memory(): { heap: number; rss: number } {
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed, rss: usage.rss };
}

function logTextBytes(response: Record<string, unknown>): number {
  const chunks = response.chunks ?? response.log_chunks;
  const diagnosticBytes =
    typeof response.diagnostic_excerpt === 'string'
      ? Buffer.byteLength(response.diagnostic_excerpt, 'utf8')
      : 0;
  if (!Array.isArray(chunks)) return diagnosticBytes;
  return (
    diagnosticBytes +
    chunks.reduce(
      (total, chunk) =>
        total +
        (chunk && typeof chunk === 'object' && 'text' in chunk
          ? Buffer.byteLength(String(chunk.text), 'utf8')
          : 0),
      0,
    )
  );
}

function measure(
  scenario: string,
  started: number,
  before: ReturnType<typeof memory>,
  response: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): number {
  const serialized = JSON.stringify(response);
  const after = memory();
  const responseBytes = Buffer.byteLength(serialized, 'utf8');
  const textBytes = logTextBytes(response);
  console.log(
    JSON.stringify({
      benchmark: 'ai-efficiency-head-mcp-v2',
      scenario,
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
      heap_delta_bytes: after.heap - before.heap,
      rss_delta_bytes: after.rss - before.rss,
      bytes_read: null,
      bytes_written: 0,
      utf8_response_bytes: responseBytes,
      presented_log_text_bytes: textBytes,
      json_metadata_bytes: responseBytes - textBytes,
      comparison: COMPARISON,
      ...extra,
    }),
  );
  return responseBytes;
}

function insertJob(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    state: 'completed' | 'running';
    outcome: 'succeeded' | 'failed' | null;
    exitCode: number | null;
    failureCategory?: string;
    failureMessage?: string;
  },
): void {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO jobs (
      id, client_id, client_request_id, state, outcome, created_at, updated_at,
      request_json, exit_code, failure_category, failure_message
    ) VALUES (?, 'benchmark', ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    input.id,
    `request-${input.id}`,
    input.state,
    input.outcome,
    now,
    now,
    input.exitCode,
    input.failureCategory ?? null,
    input.failureMessage ?? null,
  );
}

function insertAttempt(
  db: ReturnType<typeof openDatabase>,
  jobId: string,
  attemptId: string,
): void {
  db.prepare(
    `INSERT INTO job_attempts (id, job_id, ordinal, lease_id, lease_epoch, state)
     VALUES (?, ?, 1, ?, 1, 'running')`,
  ).run(attemptId, jobId, `lease-${attemptId}`);
}

async function appendChunks(
  dataDir: string,
  attemptId: string,
  count: number,
  bytesPerChunk: number,
): Promise<void> {
  const logs = await ensureAttemptLogs(attemptLogDir(dataDir, attemptId));
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const prefix = `${sequence % 2 === 0 ? 'stderr' : 'stdout'}-${sequence}:`;
    const text = `${prefix}${'x'.repeat(bytesPerChunk - Buffer.byteLength(prefix, 'utf8'))}`;
    await appendIndexedLogChunk(logs, sequence % 2 === 0 ? 'stderr' : 'stdout', text, sequence);
  }
}

describe('AI efficiency benchmark harnesses (small profile)', () => {
  it('measures actual HEAD job_run and job_logs response paths', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rbo-ai-efficiency-mcp-'));
    const db = openDatabase(':memory:');
    try {
      migrateToLatest(db);
      const controllerIdentity = await ensureControllerIdentity(dataDir);
      const context: ToolContext = {
        db,
        dataDir,
        controllerIdentity,
        identity: { client_id: 'benchmark', transport: 'internal', session_id: null },
      };

      insertJob(db, {
        id: 'job_terminal_success',
        state: 'completed',
        outcome: 'succeeded',
        exitCode: 0,
      });
      insertJob(db, {
        id: 'job_terminal_failure',
        state: 'completed',
        outcome: 'failed',
        exitCode: 1,
        failureCategory: 'execution_failed',
        failureMessage: 'deterministic failure fixture',
      });
      insertAttempt(db, 'job_terminal_failure', 'att_terminal_failure');
      const failureLogs = await ensureAttemptLogs(attemptLogDir(dataDir, 'att_terminal_failure'));
      await appendIndexedLogChunk(failureLogs, 'stderr', 'earlier diagnostic chunk\n', 1);
      await appendIndexedLogChunk(
        failureLogs,
        'stderr',
        `${'e'.repeat(20 * 1024)}\nBENCHMARK_FAILURE_SENTINEL\n`,
        2,
      );
      await appendIndexedLogChunk(failureLogs, 'stderr', 'latest diagnostic chunk\n', 3);

      insertJob(db, {
        id: 'job_nonterminal',
        state: 'running',
        outcome: null,
        exitCode: null,
      });
      insertAttempt(db, 'job_nonterminal', 'att_nonterminal');
      await appendChunks(dataDir, 'att_nonterminal', 8, 256);

      insertJob(db, {
        id: 'job_logs_page',
        state: 'running',
        outcome: null,
        exitCode: null,
      });
      insertAttempt(db, 'job_logs_page', 'att_logs_page');
      await appendChunks(dataDir, 'att_logs_page', 128, 512);

      let before = memory();
      let started = performance.now();
      const terminalSuccess = await handleToolCall(context, 'job_run', {
        job_id: 'job_terminal_success',
      });
      const terminalSuccessBytes = measure(
        'job_run_terminal_sparse_success',
        started,
        before,
        terminalSuccess,
      );
      expect(terminalSuccess).toEqual({
        job_id: 'job_terminal_success',
        state: 'completed',
        outcome: 'succeeded',
        exit_code: 0,
      });
      expect(terminalSuccessBytes).toBeLessThanOrEqual(2 * 1024);

      before = memory();
      started = performance.now();
      const terminalFailure = await handleToolCall(context, 'job_run', {
        job_id: 'job_terminal_failure',
        max_output_bytes: 16 * 1024,
      });
      const terminalFailureBytes = measure(
        'job_run_terminal_bounded_failure',
        started,
        before,
        terminalFailure,
        {
          fixture_log_bytes:
            Buffer.byteLength('earlier diagnostic chunk\n') +
            20 * 1024 +
            Buffer.byteLength('\nBENCHMARK_FAILURE_SENTINEL\nlatest diagnostic chunk\n'),
        },
      );
      expect(terminalFailure.diagnostic_excerpt).toContain('BENCHMARK_FAILURE_SENTINEL');
      expect(
        Buffer.byteLength(String(terminalFailure.diagnostic_excerpt), 'utf8'),
      ).toBeLessThanOrEqual(16 * 1024);
      expect(terminalFailureBytes).toBeLessThanOrEqual(24 * 1024);

      before = memory();
      started = performance.now();
      const nonterminal = await handleToolCall(context, 'job_run', {
        job_id: 'job_nonterminal',
        mcp_wait_slice_seconds: 1,
        max_output_bytes: 2 * 1024,
      });
      const nonterminalBytes = measure(
        'job_run_nonterminal_resume_page',
        started,
        before,
        nonterminal,
        { fixture_log_bytes: 8 * 256, configured_wait_slice_seconds: 1 },
      );
      expect(nonterminal.resume).toBe(true);
      expect(nonterminal.log_chunks).toHaveLength(8);
      expect(nonterminal.next_log_cursor).toEqual(expect.any(String));
      expect(nonterminalBytes).toBeGreaterThan(0);

      before = memory();
      started = performance.now();
      const logPage = await handleToolCall(context, 'job_logs', {
        job_id: 'job_logs_page',
        attempt_id: 'att_logs_page',
        mode: 'logs',
        max_bytes: 64 * 1024,
      });
      const logPageBytes = measure('job_logs_page', started, before, logPage, {
        fixture_log_bytes: 128 * 512,
      });
      const pageTextBytes = logTextBytes(logPage);
      expect(logPage.chunks).toHaveLength(128);
      expect(logPage.returned_bytes).toBe(64 * 1024);
      expect(pageTextBytes).toBe(64 * 1024);
      expect(logPageBytes - pageTextBytes).toBeLessThanOrEqual(16 * 1024);
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
