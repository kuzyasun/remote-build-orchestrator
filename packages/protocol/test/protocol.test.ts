import {
  ErrorCategorySchema,
  RboError,
  computeRepoKey,
  generateId,
  isPathContained,
  isValidId,
  normalizePath,
  normalizeRepositoryUrl,
  parseIdPrefix,
} from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import {
  AgentCapabilityReportSchema,
  AgentMessageTypeSchema,
  CompletionPolicySchema,
  ControllerMessageTypeSchema,
  ExecutionConfigSchema,
  JobOutcomeSchema,
  JobRequestSchema,
  JobStateSchema,
  SourcePolicySchema,
  WireMessageEnvelopeSchema,
  negotiateProtocolVersion,
} from '../src/index.js';

describe('Job Lifecycle (Section 18.1)', () => {
  it('should contain all 14 states from §18.1', () => {
    const expected = [
      'created',
      'awaiting_confirmation',
      'queued',
      'matching',
      'leased',
      'preparing_source',
      'transferring_source',
      'materializing',
      'starting',
      'running',
      'orphaned',
      'collecting_artifacts',
      'cleaning',
      'completed',
    ];
    for (const state of expected) {
      expect(() => JobStateSchema.parse(state)).not.toThrow();
    }
    expect(JobStateSchema.options).toHaveLength(14);
  });

  it('should reject unknown job state', () => {
    expect(() => JobStateSchema.parse('pending')).toThrow();
  });

  it('should contain all 5 outcomes from §18.1', () => {
    const expected = ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'];
    for (const outcome of expected) {
      expect(() => JobOutcomeSchema.parse(outcome)).not.toThrow();
    }
    expect(JobOutcomeSchema.options).toHaveLength(5);
  });
});

describe('Completion policies (Section 14)', () => {
  it('should accept run_to_exit', () => {
    expect(() => CompletionPolicySchema.parse({ type: 'run_to_exit' })).not.toThrow();
  });

  it('should accept run_for_duration with duration_seconds (§14.2)', () => {
    const parsed = CompletionPolicySchema.parse({
      type: 'run_for_duration',
      duration_seconds: 120,
    });
    expect(parsed.type).toBe('run_for_duration');
  });

  it('should accept run_until_log_match with success/failure patterns (§14.3)', () => {
    const parsed = CompletionPolicySchema.parse({
      type: 'run_until_log_match',
      success_pattern: 'ALL TESTS PASSED',
      failure_pattern: 'Guru Meditation Error',
      max_duration_seconds: 300,
    });
    expect(parsed.type).toBe('run_until_log_match');
  });

  it('should reject legacy non-design completion type names', () => {
    expect(() =>
      CompletionPolicySchema.parse({ type: 'duration', duration_seconds: 120 }),
    ).toThrow();
    expect(() =>
      CompletionPolicySchema.parse({ type: 'log_match', pattern: 'x', timeout_seconds: 10 }),
    ).toThrow();
  });

  it('should reject run_until_log_match without success_pattern', () => {
    expect(() =>
      CompletionPolicySchema.parse({ type: 'run_until_log_match', max_duration_seconds: 300 }),
    ).toThrow();
  });
});

describe('Execution config (Section 13)', () => {
  it('should accept all shell IDs from §13.3', () => {
    for (const shell of ['bash', 'zsh', 'sh', 'powershell', 'pwsh', 'cmd', 'direct']) {
      expect(() => ExecutionConfigSchema.parse({ shell, script: 'echo ok' })).not.toThrow();
    }
  });

  it('should accept user env and secret_refs (§13.4)', () => {
    const parsed = ExecutionConfigSchema.parse({
      script: 'idf.py build',
      env: { IDF_TARGET: 'esp32', CI: '1' },
      secret_refs: { GITHUB_TOKEN: 'github-readonly' },
    });
    expect(parsed.env).toEqual({ IDF_TARGET: 'esp32', CI: '1' });
    expect(parsed.secret_refs).toEqual({ GITHUB_TOKEN: 'github-readonly' });
  });
});

describe('Source policy (Section 11.12)', () => {
  it('should accept exactly the design secret policy modes block|warn|allow', () => {
    for (const mode of ['block', 'warn', 'allow']) {
      expect(() => SourcePolicySchema.parse({ secret_policy: mode })).not.toThrow();
    }
    expect(() => SourcePolicySchema.parse({ secret_policy: 'redact' })).toThrow();
  });
});

describe('Protocol Schemas (Section 13.1)', () => {
  it('should validate the canonical JobRequest from Appendix A', () => {
    const raw = {
      client_request_id: 'req_01J1234567890ABCDEFGHJKMNP',
      name: 'ESP32 QEMU integration test',
      source: {
        project_root: 'C:/develop/esp32-boilerplate',
        cwd: '.',
        additional_roots: [
          {
            source_path: 'C:/develop/DTracker/components/shared',
            mount_path: 'additional/dtracker-shared',
            exclude: ['.git/**', 'build/**'],
            mode: 'read_only',
          },
        ],
      },
      execution: {
        shell: 'bash',
        script: 'set -euo pipefail\nidf.py build\n./scripts/run-qemu-tests.sh',
        env: { IDF_TARGET: 'esp32' },
        timeout_seconds: 3600,
        idle_timeout_seconds: 600,
        cancel_grace_seconds: 10,
        tty: false,
        completion: { type: 'run_to_exit' },
      },
      requirements: {
        os: ['macos', 'linux'],
        tools: {
          'esp-idf': '>=6.0.0 <6.1.0',
          'qemu-system-xtensa': '*',
        },
        min_memory_mb: 4096,
        min_disk_mb: 20000,
      },
      preferences: {
        agent_ids: ['agt_mac'],
        prefer_repo_cache: true,
        allow_local_fallback: true,
      },
      queue_policy: 'local_fallback',
      risk_level: 'normal',
      intent: null,
      source_policy: {
        include_untracked: true,
        include_ignored: ['sdkconfig'],
        secret_policy: 'block',
      },
      artifacts: [
        { glob: 'build/*.bin', required: true },
        { glob: 'logs/**/*.log', required: false },
      ],
    };

    const parsed = JobRequestSchema.parse(raw);
    expect(parsed.client_request_id).toBe('req_01J1234567890ABCDEFGHJKMNP');
    expect(parsed.source.additional_roots[0]?.mount_path).toBe('additional/dtracker-shared');
    expect(parsed.execution.env).toEqual({ IDF_TARGET: 'esp32' });
    expect(parsed.risk_level).toBe('normal');
    expect(parsed.artifacts).toHaveLength(2);
  });

  it('should reject additional_roots given as plain strings', () => {
    expect(() =>
      JobRequestSchema.parse({
        client_request_id: 'req_1',
        source: {
          project_root: '/app',
          additional_roots: ['C:/develop/DTracker/components/shared'],
        },
        execution: { script: 'echo ok' },
      }),
    ).toThrow();
  });

  it('should reject JobRequest with missing required fields', () => {
    expect(() =>
      JobRequestSchema.parse({
        client_request_id: 'req_test',
      }),
    ).toThrow();
  });

  it('should reject JobRequest with empty client_request_id', () => {
    expect(() =>
      JobRequestSchema.parse({
        client_request_id: '',
        source: { project_root: '/app' },
        execution: { script: 'echo ok' },
      }),
    ).toThrow();
  });

  it('should reject JobRequest with empty script', () => {
    expect(() =>
      JobRequestSchema.parse({
        client_request_id: 'req_1',
        source: { project_root: '/app' },
        execution: { script: '' },
      }),
    ).toThrow();
  });
});

describe('Wire Protocol (Section 20)', () => {
  it('should validate Agent→Controller message types (§20.3)', () => {
    const agentTypes = [
      'hello',
      'pairing_request',
      'capabilities',
      'heartbeat',
      'lease_accept',
      'lease_reject',
      'source_need',
      'source_ready',
      'job_started',
      'log_chunk',
      'job_exit',
      'artifact_manifest',
      'cleanup_complete',
      'agent_error',
    ];
    for (const t of agentTypes) {
      expect(() => AgentMessageTypeSchema.parse(t)).not.toThrow();
    }
    expect(AgentMessageTypeSchema.options).toHaveLength(14);
  });

  it('should validate Controller→Agent message types (§20.4)', () => {
    const controllerTypes = [
      'hello_ack',
      'pairing_challenge',
      'lease_offer',
      'prepare_source',
      'snapshot_download',
      'bundle_download',
      'run_job',
      'cancel_job',
      'pause',
      'resume',
      'refresh_capabilities',
      'shutdown',
    ];
    for (const t of controllerTypes) {
      expect(() => ControllerMessageTypeSchema.parse(t)).not.toThrow();
    }
    expect(ControllerMessageTypeSchema.options).toHaveLength(12);
  });

  it('should validate Section 20.2 WireMessageEnvelope', () => {
    const envelope = {
      protocol: 1,
      type: 'heartbeat',
      message_id: 'msg_01J1234567890ABCDEFGHJKMNP',
      sent_at: new Date().toISOString(),
      attempt_id: null,
      lease_id: null,
      lease_epoch: null,
      payload: {},
    };

    const parsed = WireMessageEnvelopeSchema.parse(envelope);
    expect(parsed.protocol).toBe(1);
    expect(parsed.type).toBe('heartbeat');
  });

  it('should reject job-scoped messages with null lease fields (§20.2)', () => {
    // "Повідомлення, пов'язані з job, обов'язково містять усі три lease-поля."
    for (const type of ['lease_offer', 'run_job', 'log_chunk', 'job_exit']) {
      expect(() =>
        WireMessageEnvelopeSchema.parse({
          protocol: 1,
          type,
          message_id: 'msg_01J1234567890ABCDEFGHJKMNP',
          sent_at: new Date().toISOString(),
          attempt_id: null,
          lease_id: null,
          lease_epoch: null,
          payload: {},
        }),
      ).toThrow();
    }
  });

  it('should accept job-scoped message with all lease fields present', () => {
    const parsed = WireMessageEnvelopeSchema.parse({
      protocol: 1,
      type: 'run_job',
      message_id: 'msg_01J1234567890ABCDEFGHJKMNP',
      sent_at: new Date().toISOString(),
      attempt_id: 'att_01J1234567890ABCDEFGHJKMNP',
      lease_id: 'lease_01J1234567890ABCDEFGHJKMNP',
      lease_epoch: 1,
      payload: {},
    });
    expect(parsed.type).toBe('run_job');
  });

  it('should reject unknown message type in envelope', () => {
    expect(() =>
      WireMessageEnvelopeSchema.parse({
        protocol: 1,
        type: 'not_a_real_type',
        message_id: 'msg_1',
        sent_at: new Date().toISOString(),
        attempt_id: null,
        lease_id: null,
        lease_epoch: null,
        payload: {},
      }),
    ).toThrow();
  });
});

describe('Protocol Version Negotiation', () => {
  it('should negotiate compatible protocol version', () => {
    const negotiated = negotiateProtocolVersion({ min_version: 1, max_version: 1 });
    expect(negotiated).toBe(1);
  });

  it('should reject incompatible protocol version', () => {
    const negotiated = negotiateProtocolVersion({ min_version: 2, max_version: 5 });
    expect(negotiated).toBeNull();
  });
});

describe('Shared Utilities', () => {
  it('ErrorCategorySchema from @rbo/shared should validate all §30 categories', () => {
    const categories = [
      'validation',
      'no_matching_agent',
      'no_capacity',
      'timeout',
      'cancelled',
      'internal',
    ];
    for (const cat of categories) {
      expect(() => ErrorCategorySchema.parse(cat)).not.toThrow();
    }
    expect(() => ErrorCategorySchema.parse('unknown_category')).toThrow();
  });

  it('should generate and validate ULID with prefix', () => {
    const jobId = generateId('job');
    expect(jobId).toMatch(/^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i);
    expect(isValidId(jobId)).toBe(true);
    expect(isValidId(jobId, 'job')).toBe(true);
    expect(isValidId(jobId, 'att')).toBe(false);
    expect(parseIdPrefix(jobId)).toBe('job');
  });

  it('should support msg and req id prefixes used by the wire protocol (§20.2)', () => {
    const msgId = generateId('msg');
    expect(isValidId(msgId, 'msg')).toBe(true);
    expect(parseIdPrefix(msgId)).toBe('msg');
    const reqId = generateId('req');
    expect(isValidId(reqId, 'req')).toBe(true);
  });

  it('should format RboError correctly', () => {
    const err = RboError.validation('Invalid field', { field: 'project_root' });
    expect(err.category).toBe('validation');
    expect(err.retryable).toBe(false);
    const json = err.toJSON();
    expect(json.category).toBe('validation');
    expect(json.details?.field).toBe('project_root');
  });

  it('should normalize repository URL and compute canonical repo key (Section 10.2)', () => {
    const sshUrl = 'git@github.com:kuzyasun/esp32-boilerplate.git';
    const httpsUrl = 'https://github.com/kuzyasun/esp32-boilerplate.git';

    const normalizedSsh = normalizeRepositoryUrl(sshUrl);
    const normalizedHttps = normalizeRepositoryUrl(httpsUrl);

    expect(normalizedSsh).toBe('github.com/kuzyasun/esp32-boilerplate');
    expect(normalizedHttps).toBe('github.com/kuzyasun/esp32-boilerplate');
    expect(computeRepoKey(sshUrl)).toBe(computeRepoKey(httpsUrl));
  });

  it('should normalize ssh:// URL with explicit port to the same canonical id', () => {
    expect(normalizeRepositoryUrl('ssh://git@github.com:22/kuzyasun/esp32-boilerplate.git')).toBe(
      'github.com/kuzyasun/esp32-boilerplate',
    );
  });

  it('should lowercase only the host, preserving repository path case', () => {
    expect(normalizeRepositoryUrl('https://GitHub.com/Kuzyasun/Esp32-Boilerplate.git')).toBe(
      'github.com/Kuzyasun/Esp32-Boilerplate',
    );
  });

  it('should handle path normalization and containment check', () => {
    expect(normalizePath('C:\\projects\\app\\')).toBe('C:/projects/app');
    expect(isPathContained('C:/projects/app', 'C:/projects/app/src/index.ts')).toBe(true);
    expect(isPathContained('C:/projects/app', 'C:/projects/other')).toBe(false);
  });
});
