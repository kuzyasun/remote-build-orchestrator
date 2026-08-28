import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JOB_LOGS_INPUT } from '../src/mcp-tools.js';

const schema = z.object(JOB_LOGS_INPUT).strict();

describe('job_logs wire contract', () => {
  const base = { job_id: 'job-1', mode: 'logs' as const };

  it('requires an explicit mode and rejects the removed streams field', () => {
    expect(schema.safeParse({ job_id: 'job-1' }).success).toBe(false);
    expect(schema.safeParse({ ...base, streams: ['stdout'] }).success).toBe(false);
  });

  it('accepts only opaque string cursors and enforces the byte bounds', () => {
    expect(schema.safeParse({ ...base, cursor: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, cursor: 'x'.repeat(513) }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_bytes: 3 }).success).toBe(false);
    expect(schema.safeParse({ ...base, cursor: null, max_bytes: 4 }).success).toBe(true);
  });

  it('accepts the separate events mode', () => {
    expect(schema.safeParse({ job_id: 'job-1', mode: 'events', cursor: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, mode: 'other' }).success).toBe(false);
  });
});
