import type { JobRequest } from '@rbo/protocol';
import { generateDeviceKeyPair } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { loadControllerConfig } from '../src/config.js';
import { createJob, getJob, persistSnapshot, transitionJobState } from '../src/jobs/lifecycle.js';
import { dispatchJobExecution } from '../src/jobs/submit.js';
import { selectAgentForJob } from '../src/scheduler/index.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

function makeRequest(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    client_request_id: 'req_fallback',
    source: { project_root: '/tmp', cwd: '.' },
    execution: { script: 'echo test' },
    queue_policy: 'local_fallback',
    risk_level: 'normal',
    ...overrides,
  };
}

describe('allowLocalFallback config (§2.3)', () => {
  it('loadControllerConfig defaults allowLocalFallback to true', () => {
    const config = loadControllerConfig({ dataDir: '/tmp/rbo-test', configPath: null });
    expect(config.allowLocalFallback).toBe(true);
  });

  it('loadControllerConfig reads RBO_ALLOW_LOCAL_FALLBACK=false', () => {
    const prev = process.env.RBO_ALLOW_LOCAL_FALLBACK;
    process.env.RBO_ALLOW_LOCAL_FALLBACK = 'false';
    try {
      const config = loadControllerConfig({ dataDir: '/tmp/rbo-test', configPath: null });
      expect(config.allowLocalFallback).toBe(false);
    } finally {
      if (prev === undefined) {
        process.env.RBO_ALLOW_LOCAL_FALLBACK = undefined;
      } else {
        process.env.RBO_ALLOW_LOCAL_FALLBACK = prev;
      }
    }
  });

  it('selectAgentForJob fail_fast when config disables local fallback', () => {
    const req = makeRequest({ requirements: { os: ['linux'] } });
    expect(selectAgentForJob([], req, { allowLocalFallback: false }).action).toBe('fail_fast');
  });

  it('dispatchJobExecution fail_fast when no agents and allowLocalFallback is false', async () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);

    const snapshotId = 'snp_no_fallback';
    persistSnapshot(db, {
      snapshotId,
      contentId: 'cid_no_fallback',
      repoId: 'local',
      baseCommit: null,
      dirty: false,
      manifestPath: '/tmp/manifest.json',
      payloadPath: '/tmp/payload.bin',
      sizeBytes: 64,
      sha256: 'b'.repeat(64),
    });

    const request = makeRequest({ requirements: { os: ['linux'] } });
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: request.client_request_id,
      request,
      initialState: 'queued',
    });
    transitionJobState(db, job.id, 'queued', { snapshot_id: snapshotId });

    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES (?, ?, ?, 'offline', ?, ?)`,
    ).run(
      'agt_offline',
      'offline-agent',
      'C:/private/agent-hostname',
      JSON.stringify({ execution: { shells: ['powershell'] } }),
      new Date().toISOString(),
    );

    const keys = generateDeviceKeyPair();
    const identity: ControllerIdentity = {
      controllerId: 'controller_fallback_test',
      tlsCertPem: '',
      tlsKeyPem: '',
      signingPublicKeyPem: keys.publicKeyPem,
      signingPrivateKeyPem: keys.privateKeyPem,
      fingerprint: 'sha256:test',
    };

    await dispatchJobExecution(
      {
        clientId: 'client',
        controllerIdentity: identity,
        db,
        dataDir: '/tmp/rbo-fallback',
        allowedProjectRoots: ['/tmp'],
        allowedArtifactDestinations: [],
        allowLocalFallback: false,
      },
      job.id,
      request,
    );

    const updated = getJob(db, job.id);
    expect(updated?.state).toBe('completed');
    expect(updated?.outcome).toBe('failed');
    expect(updated?.failure_category).toBe('no_matching_agent');
    expect(updated?.failure_message).toBe(
      'No registered Agent is online. Reconnect an Agent or use queue_policy="wait".',
    );
    expect(updated?.failure_message).not.toContain('private/agent-hostname');
    expect(updated?.result_json).not.toContain('private/agent-hostname');
    expect(JSON.parse(updated?.result_json ?? '{}')).toEqual({
      no_match: {
        category: 'no_matching_agent',
        retryable: false,
        required_shell: 'bash',
        target_os: ['linux'],
        hint: 'No registered Agent is online. Reconnect an Agent or use queue_policy="wait".',
      },
    });
    db.close();
  });
});
