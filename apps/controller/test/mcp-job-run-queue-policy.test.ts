import { describe, expect, it, vi } from 'vitest';

const handleJobRun = vi.hoisted(() => vi.fn());

vi.mock('../src/jobs/job-run.js', () => ({ handleJobRun }));

import { handleToolCall } from '../src/mcp/handlers.js';

describe('job_run queue_policy mapping', () => {
  it.each(['local_fallback', 'wait', 'fail_fast'] as const)(
    'passes explicit queue_policy=%s through the MCP handler unchanged',
    async (queue_policy) => {
      handleJobRun.mockResolvedValue({ job_id: 'job_queue_policy' });

      await handleToolCall(
        {
          db: {} as never,
          dataDir: '/data',
          identity: { client_id: 'mcp-client', transport: 'http', session_id: null },
          controllerIdentity: {} as never,
        },
        'job_run',
        {
          command: 'echo policy',
          project_root: '/tmp/app',
          queue_policy,
        },
      );

      expect(handleJobRun).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ queue_policy }),
        undefined,
      );
    },
  );

  it('forwards an omitted queue_policy as undefined for Controller default normalization', async () => {
    handleJobRun.mockResolvedValue({ job_id: 'job_default_queue_policy' });

    await handleToolCall(
      {
        db: {} as never,
        dataDir: '/data',
        identity: { client_id: 'mcp-client', transport: 'http', session_id: null },
        controllerIdentity: {} as never,
      },
      'job_run',
      {
        command: 'echo default policy',
        project_root: '/tmp/app',
      },
    );

    expect(handleJobRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ queue_policy: undefined }),
      undefined,
    );
  });
});
