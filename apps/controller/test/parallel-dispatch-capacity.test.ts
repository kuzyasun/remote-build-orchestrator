import { generateDeviceKeyPair } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createJob,
  getLatestAttempt,
  persistSnapshot,
  transitionJobState,
} from '../src/jobs/lifecycle.js';
import { type SubmitJobContext, dispatchJobExecution } from '../src/jobs/submit.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

/**
 * Reproduces the user-reported scenario: an agent has max_jobs=3 and ONE job running, but a second
 * parallel job does not start. This test proves whether the controller's capacity logic correctly
 * selects a partially-busy agent (active < max_jobs) for a second concurrent dispatch.
 */

const AGENT_ID = 'agt_capacity';

function makeCapabilities(maxJobs: number) {
  return {
    agent_id: AGENT_ID,
    display_name: 'capacity-agent',
    hostname: 'localhost',
    os: { family: 'linux', version: '10', arch: 'x64' },
    resources: {
      cpu_logical: 8,
      memory_total_mb: 16384,
      memory_free_mb: 8192,
      disk_free_mb: 50000,
    },
    execution: {
      max_jobs: maxJobs,
      shells: ['bash'],
      supports_tty: false,
      supports_process_tree_kill: true,
    },
    tools: {},
    toolchain_profiles: [],
    labels: {},
    secret_refs: [],
    accepting_jobs: true,
  };
}

/** Insert a fake but DB-valid "running" attempt pinned to the agent, simulating one in-flight job. */
function seedRunningAttempt(db: ControllerDatabase, jobId: string): void {
  db.prepare(
    `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
     VALUES (?, ?, 1, ?, ?, 1, ?, 'running')`,
  ).run(
    `att_seed_${jobId}`,
    jobId,
    AGENT_ID,
    `lease_seed_${jobId}`,
    new Date(Date.now() + 60_000).toISOString(),
  );
}

/** Create a fully-valid first job (with snapshot) that is already "running" on the agent. */
function createRunningFirstJob(db: ControllerDatabase): string {
  const request = {
    client_request_id: 'req_first_running',
    source: { project_root: '/tmp', cwd: '.' },
    execution: { script: 'echo first' },
    queue_policy: 'wait',
    risk_level: 'normal',
  };
  const job = createJob(db, {
    clientId: 'client',
    clientRequestId: 'req_first_running',
    request,
    initialState: 'running',
  });
  const snapshotId = 'snp_first_running';
  persistSnapshot(db, {
    snapshotId,
    contentId: 'cid_first',
    repoId: 'local',
    baseCommit: null,
    dirty: false,
    manifestPath: '/tmp/m.json',
    payloadPath: '/tmp/p.bin',
    sizeBytes: 64,
    sha256: 'a'.repeat(64),
  });
  transitionJobState(db, job.id, 'running', { snapshot_id: snapshotId });
  seedRunningAttempt(db, job.id);
  return job.id;
}

describe('parallel dispatch respects max_jobs capacity (not single-job busy)', () => {
  let db: ControllerDatabase;
  let identity: ControllerIdentity;
  let offeredLeases: string[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrateToLatest(db);
    const keys = generateDeviceKeyPair();
    identity = {
      controllerId: 'controller_capacity_test',
      tlsCertPem: '',
      tlsKeyPem: '',
      signingPublicKeyPem: keys.publicKeyPem,
      signingPrivateKeyPem: keys.privateKeyPem,
      fingerprint: 'sha256:cap',
    };
    offeredLeases = [];
  });

  afterEach(() => {
    db.close();
  });

  function seedAgent(maxJobs: number): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, max_jobs, capabilities_json, paired_at, last_seen_at)
       VALUES (?, ?, 'localhost', 'busy', ?, ?, ?, ?)`,
    ).run(AGENT_ID, 'capacity-agent', maxJobs, JSON.stringify(makeCapabilities(maxJobs)), now, now);
  }

  function buildCtx(maxJobs: number): SubmitJobContext {
    // Mock WebSocket that records lease_offer sends (initiateRemoteAttempt sends lease_offer).
    const mockSocket = {
      readyState: 1, // OPEN
      OPEN: 1, // matches ws.WebSocket.OPEN static constant used by initiateRemoteAttempt
      send: (data: string) => {
        try {
          const frame = JSON.parse(data);
          if (frame.type === 'lease_offer') {
            offeredLeases.push(frame.lease_id ?? frame.attempt_id ?? 'lease');
          }
        } catch {
          // ignore non-JSON frames
        }
      },
      close: () => undefined,
    } as unknown as import('ws').WebSocket;

    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        AGENT_ID,
        { agentId: AGENT_ID, socket: mockSocket, protocolVersion: 1, lastHeartbeatAt: Date.now() },
      ],
    ]);

    return {
      clientId: 'capacity-client',
      controllerIdentity: identity,
      db,
      dataDir: '/tmp/rbo-capacity',
      allowedProjectRoots: ['/tmp'],
      allowedArtifactDestinations: [],
      connectedAgents,
      agentPlanePort: 7411,
      controllerPublicHost: '127.0.0.1',
      defaultQueuePolicy: 'wait',
    };
  }

  function submitSecondJob(): string {
    const request = {
      client_request_id: 'req_second_parallel',
      source: { project_root: '/tmp', cwd: '.' },
      execution: { script: 'echo second' },
      queue_policy: 'wait' as const,
      risk_level: 'normal' as const,
    };
    const job = createJob(db, {
      clientId: 'capacity-client',
      clientRequestId: 'req_second_parallel',
      request,
      initialState: 'queued',
    });
    const snapshotId = 'snp_second';
    persistSnapshot(db, {
      snapshotId,
      contentId: 'cid_second',
      repoId: 'local',
      baseCommit: null,
      dirty: false,
      manifestPath: '/tmp/m.json',
      payloadPath: '/tmp/p.bin',
      sizeBytes: 64,
      sha256: 'c'.repeat(64),
    });
    transitionJobState(db, job.id, 'queued', {
      snapshot_id: snapshotId,
      queued_at: new Date().toISOString(),
    });
    return job.id;
  }

  it('dispatches a second parallel job when one is running and max_jobs=3 (agent reports busy)', async () => {
    // --- Arrange: one in-flight job already running on the agent (max_jobs=3) ---
    seedAgent(3);
    const firstJobId = createRunningFirstJob(db); // → activeJobsCount for AGENT_ID = 1

    const ctx = buildCtx(3);
    const secondJobId = submitSecondJob();

    // --- Act: dispatch the second job as handleJobSubmit does ---
    await dispatchJobExecution(
      ctx,
      secondJobId,
      JSON.parse(
        (
          db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(secondJobId) as {
            request_json: string;
          }
        ).request_json,
      ),
    );

    // --- Assert: the second job got a lease attempt on the same agent (parallel dispatch) ---
    expect(offeredLeases).toHaveLength(1);
    const attempt = getLatestAttempt(db, secondJobId);
    expect(attempt?.agent_id).toBe(AGENT_ID);
    expect(attempt?.state).toBe('leasing');
    // The original running attempt is untouched (still 1, now 2 total attempts on the agent).
    expect(getLatestAttempt(db, firstJobId)?.state).toBe('running');
  });

  it('does NOT dispatch a second job when the agent is at capacity (active == max_jobs)', async () => {
    // max_jobs=1, one running → at capacity. Second job must be queued (wait), not dispatched.
    seedAgent(1);
    const firstJobId = createRunningFirstJob(db); // activeJobsCount = 1

    const ctx = buildCtx(1);
    const secondJobId = submitSecondJob();

    await dispatchJobExecution(
      ctx,
      secondJobId,
      JSON.parse(
        (
          db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(secondJobId) as {
            request_json: string;
          }
        ).request_json,
      ),
    );

    // No lease offered — agent excluded by capacity filter; wait-policy job stays queued.
    expect(offeredLeases).toHaveLength(0);
    expect(getLatestAttempt(db, secondJobId)).toBeNull();
    expect(
      (db.prepare('SELECT state FROM jobs WHERE id = ?').get(secondJobId) as { state: string })
        .state,
    ).toBe('queued');
  });
});
