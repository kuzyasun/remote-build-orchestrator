import { describe, expect, it } from 'vitest';

describe('AI efficiency benchmark harnesses (small profile)', () => {
  it('measures serialized job_run response size', () => {
    const response = {
      job_id: 'job_benchmark',
      state: 'succeeded',
      outcome: 'succeeded',
      exit_code: 0,
      failure_category: null,
      failure_message: null,
      resume: false,
      log_tail: {
        stdout: ['benchmark output'],
        stderr: [],
        attempt_id: 'att_benchmark',
      },
      artifacts: [],
    };
    const before = process.memoryUsage();
    const started = performance.now();
    const serialized = JSON.stringify(response);
    const after = process.memoryUsage();
    const bytes = Buffer.byteLength(serialized, 'utf8');
    console.log(
      JSON.stringify({
        scenario: 'job_run_response_serialization',
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
        bytes_read: 0,
        bytes_written: 0,
        utf8_response_bytes: bytes,
        heap_delta_bytes: after.heapUsed - before.heapUsed,
        rss_delta_bytes: after.rss - before.rss,
        duplicate_count: 0,
        missing_count: 0,
      }),
    );
    expect(bytes).toBeGreaterThan(0);
    expect(JSON.parse(serialized)).toEqual(response);
  });
});
