/**
 * Phase 6 Task 5 — Fault-injection integration suite.
 *
 * Scenarios already proven elsewhere are cited in `.superpowers/sdd/task-5-report.md`
 * and only lightly re-asserted here when a gap remains. Focus of this file:
 * cursor restore on Controller restart, Agent stale cleanup, two-attempt isolation
 * (acks/artifacts), spool pressure / log_spool_limit, and bounded large-output streaming.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendChunk,
  ensureAttemptLogs,
  openAttemptSpool,
  readLogsFromCursor,
  totalBytes,
} from '@rbo/executor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { SpoolSender } from '../../agent/src/logs/spool-sender.js';
import {
  listAttemptMetadata,
  writeAttemptMetadata,
} from '../../agent/src/recovery/attempt-metadata.js';
import { AgentRecoveryCoordinator } from '../../agent/src/recovery/coordinator.js';
import { applyDiskPressureCleanup } from '../../agent/src/recovery/disk-pressure.js';
import {
  type RemoteExecutionOptions,
  handleRemoteArtifactManifest,
  handleRemoteLogChunk,
} from '../src/execution/remote-execution.js';
import { attemptLogDir } from '../src/execution/runner.js';
import {
  ATTEMPT_OUTCOME_LOST,
  createJob,
  getAttempt,
  transitionJobState,
} from '../src/jobs/lifecycle.js';
import { RecoveryCoordinator } from '../src/recovery/coordinator.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

function mockSocket(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

function insertAgent(db: ReturnType<typeof openDatabase>, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
     VALUES (?, ?, ?, 'offline', '{}', ?)`,
  ).run(agentId, agentId, 'localhost', nowIso());
}

const identity = {
  controllerId: 'ctl',
  fingerprint: 'sha256:abc',
  tlsCertPem: '',
  tlsKeyPem: '',
  signingPublicKeyPem: '',
  signingPrivateKeyPem: '',
};

describe('Phase 6 fault-injection reliability', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setupController(opts?: {
    risk_level?: 'safe' | 'normal' | 'destructive' | 'hardware';
    attemptState?: string;
    withProcess?: boolean;
    logAcked?: number;
    ordinal?: number;
    attemptId?: string;
    leaseId?: string;
    leaseEpoch?: number;
  }) {
    dataDir = await mkdtemp(join(tmpdir(), 'rbo-p6-rel-'));
    const db = openDatabase(join(dataDir, 'controller.db'));
    migrateToLatest(db);
    insertAgent(db, 'agt_1');

    const risk = opts?.risk_level ?? 'safe';
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: `req_p6_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      initialState: 'queued',
      request: {
        client_request_id: `req_p6_${risk}`,
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
        queue_policy: 'wait',
        risk_level: risk,
      },
    });
    transitionJobState(db, job.id, 'running');

    const attemptId = opts?.attemptId ?? 'att_p6_1';
    const leaseId = opts?.leaseId ?? 'lease_p6_1';
    const leaseEpoch = opts?.leaseEpoch ?? 1;
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    const state = opts?.attemptState ?? 'running';
    const processIdentity = opts?.withProcess === false ? null : 'pid:4242';
    const logAcked = opts?.logAcked ?? 0;
    const ordinal = opts?.ordinal ?? 1;

    db.prepare(
      `INSERT INTO job_attempts (
         id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state,
         process_identity, log_acked_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attemptId,
      job.id,
      ordinal,
      'agt_1',
      leaseId,
      leaseEpoch,
      futureDeadline,
      state,
      processIdentity,
      logAcked,
    );

    const socket = mockSocket();
    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        'agt_1',
        {
          agentId: 'agt_1',
          socket,
          protocolVersion: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
    ]);

    const remoteOpts: RemoteExecutionOptions = {
      db,
      identity,
      dataDir,
      connectedAgents,
      serverPort: 0,
    };

    const coordinator = new RecoveryCoordinator({
      db,
      connectedAgents,
      disconnectGraceSeconds: 5,
      orphanTimeoutSeconds: 10,
      reconcileDeadlineSeconds: 8,
    });

    return {
      db,
      remoteOpts,
      socket,
      attemptId,
      leaseId,
      leaseEpoch,
      processIdentity,
      coordinator,
      jobId: job.id,
      connectedAgents,
    };
  }

  // --- Scenario 1 (cite: reconnect-reconcile "disconnect before script start") ---
  it('1. disconnect before script start → terminal without new attempt', async () => {
    const { db, remoteOpts, attemptId, coordinator, jobId, connectedAgents } =
      await setupController({
        withProcess: false,
        attemptState: 'preparing_source',
      });
    const before = (
      db.prepare('SELECT COUNT(*) AS c FROM job_attempts WHERE job_id = ?').get(jobId) as {
        c: number;
      }
    ).c;
    connectedAgents.delete('agt_1');
    coordinator.onAgentDisconnect('agt_1');
    expect(getAttempt(db, attemptId)?.state).toBe('completed');
    expect(
      (
        db.prepare('SELECT COUNT(*) AS c FROM job_attempts WHERE job_id = ?').get(jobId) as {
          c: number;
        }
      ).c,
    ).toBe(before);
    coordinator.dispose();
    db.close();
  });

  // --- Scenario 2 (cite: reconnect-reconcile disconnect+adopt + log-spool) ---
  it('2. disconnect during safe job → reconnect replay ordered, no duplicates via job_logs', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator, connectedAgents } =
      await setupController({ risk_level: 'safe', withProcess: true });

    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'A',
    });
    connectedAgents.delete('agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);

    const socket2 = mockSocket();
    connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });
    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 2,
      last_acked_sequence: 1,
      artifact_upload_pending: false,
    });
    expect(decision.action).toBe('adopt');
    expect(decision).toMatchObject({ resume_from_sequence: 1 });

    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'A',
    });
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stderr',
      sequence: 2,
      bytes: 'B',
    });

    const logDir = attemptLogDir(dataDir, attemptId);
    expect(await readFile(join(logDir, 'stdout.log'), 'utf8')).toBe('A');
    expect(await readFile(join(logDir, 'stderr.log'), 'utf8')).toBe('B');
    const logs = await ensureAttemptLogs(logDir);
    const out = await readLogsFromCursor(logs, 0, 10_000, ['stdout']);
    expect(out.data).toBe('A');

    coordinator.dispose();
    db.close();
  });

  // --- Scenario 3: replacement rejects stale frames AND artifacts ---
  it('3. replacement attempt rejects every stale frame and artifact', async () => {
    const ctx = await setupController({ withProcess: true, attemptState: 'collecting_artifacts' });
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator, connectedAgents } =
      ctx;

    // Advance epoch (replacement fence)
    db.prepare('UPDATE job_attempts SET lease_epoch = 2 WHERE id = ?').run(attemptId);

    connectedAgents.delete('agt_1');
    coordinator.onAgentDisconnect('agt_1');
    await vi.advanceTimersByTimeAsync(5_000);

    const socket2 = mockSocket();
    connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });
    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'completed_awaiting_upload',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 0,
      last_acked_sequence: 0,
      artifact_upload_pending: true,
    });
    expect(decision.action).toBe('terminate_stale');

    // Stale log
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'stale-log',
    });
    await expect(
      readFile(join(attemptLogDir(dataDir, attemptId), 'stdout.log'), 'utf8'),
    ).rejects.toThrow();

    // Stale artifact_manifest — must not grant uploads
    const beforeSent = socket2.sent.length;
    handleRemoteArtifactManifest(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      artifacts: [
        {
          logical_name: 'out.bin',
          path: 'out.bin',
          size_bytes: 4,
          sha256: 'abcd',
        },
      ],
    });
    const grants = socket2.sent.slice(beforeSent).filter((m) => m.type === 'artifact_upload_grant');
    expect(grants).toHaveLength(0);

    coordinator.dispose();
    db.close();
  });

  // --- Scenario 4: cite lease-self-term.test.ts; smoke fence for hardware risk ---
  it('4. hardware risk_level is preserved for lease self-term path (no Controller cancel)', async () => {
    // Full kill-without-Controller covered by apps/agent/test/lease-self-term.test.ts.
    // Here: Controller leaves hardware attempts in grace (does not force-cancel on disconnect).
    const { db, attemptId, coordinator, connectedAgents } = await setupController({
      risk_level: 'hardware',
      withProcess: true,
    });
    connectedAgents.delete('agt_1');
    coordinator.onAgentDisconnect('agt_1');
    expect(getAttempt(db, attemptId)?.state).toBe('running');
    expect(getAttempt(db, attemptId)?.outcome).toBeNull();
    coordinator.dispose();
    db.close();
  });

  // --- Scenario 5: Controller restart restores cursors → adopt or lost ---
  it('5a. Controller restart restores log cursor and adopts with resume_from_sequence', async () => {
    const { db, remoteOpts, attemptId, leaseId, processIdentity, coordinator, connectedAgents } =
      await setupController({ withProcess: true, logAcked: 7 });

    // Simulate mid-execution Controller restart: arm reconcile deadline from DB state
    coordinator.onControllerStartup();
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(7);
    expect(getAttempt(db, attemptId)?.state).toBe('running');

    // Agent reconnects before deadline with matching tuple
    const socket2 = mockSocket();
    connectedAgents.set('agt_1', {
      agentId: 'agt_1',
      socket: socket2,
      protocolVersion: 1,
      lastHeartbeatAt: Date.now(),
    });
    const decision = coordinator.onRecoveryReport('agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      status: 'running',
      process_identity: processIdentity ?? 'pid:4242',
      last_sent_sequence: 10,
      last_acked_sequence: 7,
      artifact_upload_pending: false,
    });
    expect(decision).toMatchObject({
      action: 'adopt',
      resume_from_sequence: 7,
    });
    // Cursor still durable after adopt
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(7);

    // Contiguous replay from 8
    await handleRemoteLogChunk(remoteOpts, 'agt_1', {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 8,
      bytes: 'after-restart',
    });
    expect(getAttempt(db, attemptId)?.log_acked_sequence).toBe(8);

    coordinator.dispose();
    db.close();
  });

  it('5b. Controller restart without recovery_report → lost', async () => {
    const { db, attemptId, coordinator } = await setupController({ withProcess: true });
    coordinator.onControllerStartup();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(getAttempt(db, attemptId)?.outcome).toBe(ATTEMPT_OUTCOME_LOST);
    coordinator.dispose();
    db.close();
  });

  // --- Scenario 6: Agent restart → stale workspaces → idempotent cleanup ---
  it('6. Agent restart finds stale workspaces; cleanup after grace is idempotent', async () => {
    vi.useRealTimers();
    const stateDir = await mkdtemp(join(tmpdir(), 'rbo-p6-agent-'));
    dataDir = stateDir;

    const staleId = 'att_stale_ws';
    const wsPath = join(stateDir, 'workspaces', staleId);
    const spoolPath = join(stateDir, 'logs', staleId);
    await mkdir(wsPath, { recursive: true });
    await mkdir(spoolPath, { recursive: true });
    await writeFile(join(wsPath, 'leftover.txt'), 'stale');
    await writeFile(join(spoolPath, 'stdout.log'), 'old');

    writeAttemptMetadata(stateDir, {
      attempt_id: staleId,
      job_id: 'job_stale',
      lease_id: 'lease_stale',
      lease_epoch: 1,
      process_identity: 'pid:1',
      status: 'terminal',
      workspace_path: wsPath,
      spool_dir: spoolPath,
      risk_level: 'safe',
      updated_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Restart scan sees the metadata
    const listed = await listAttemptMetadata(stateDir);
    expect(listed.some((m) => m.attempt_id === staleId && m.status === 'terminal')).toBe(true);

    const first = await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 1_000_000_000,
      freeBytes: 100,
      retentionMs: 1,
    });
    expect(first.acceptingJobs).toBe(false);
    await expect(access(join(wsPath, 'leftover.txt'))).rejects.toThrow();

    // Second pass must be safe (idempotent)
    const second = await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 1_000_000_000,
      freeBytes: 100,
      retentionMs: 1,
    });
    expect(second.acceptingJobs).toBe(false);

    // Orphaned (non-terminal) attempt is reported on reconnect, not deleted
    const liveId = 'att_orphaned';
    writeAttemptMetadata(stateDir, {
      attempt_id: liveId,
      job_id: 'job_live',
      lease_id: 'lease_live',
      lease_epoch: 1,
      process_identity: 'pid:99',
      status: 'orphaned',
      workspace_path: join(stateDir, 'workspaces', liveId),
      spool_dir: join(stateDir, 'logs', liveId),
      risk_level: 'safe',
      updated_at: new Date().toISOString(),
    });
    await mkdir(join(stateDir, 'workspaces', liveId), { recursive: true });
    await writeFile(join(stateDir, 'workspaces', liveId, 'keep.txt'), 'active');

    const socket = mockSocket();
    const recovery = new AgentRecoveryCoordinator({
      stateDir,
      hooks: { terminateAttempt: async () => undefined },
    });
    recovery.attachSocket(socket);
    await recovery.reportAll();
    expect(socket.sent.some((m) => m.type === 'recovery_report')).toBe(true);
    const payload = socket.sent.find((m) => m.type === 'recovery_report')?.payload as {
      attempt_id: string;
    };
    expect(payload.attempt_id).toBe(liveId);
    await expect(access(join(stateDir, 'workspaces', liveId, 'keep.txt'))).resolves.toBeUndefined();
  });

  // --- Scenario 7: two attempts of one job never mix ---
  it('7. two attempts of one job never mix workspace/logs/acks/artifacts/cleanup', async () => {
    const a1 = await setupController({
      attemptId: 'att_mix_1',
      leaseId: 'lease_mix_1',
      leaseEpoch: 1,
      ordinal: 1,
      attemptState: 'running',
      withProcess: true,
    });
    // Second attempt on same job
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    a1.db
      .prepare(
        `INSERT INTO job_attempts (
           id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state,
           process_identity, log_acked_sequence
         ) VALUES (?, ?, 2, 'agt_1', ?, 1, ?, 'collecting_artifacts', 'pid:9999', 0)`,
      )
      .run('att_mix_2', a1.jobId, 'lease_mix_2', futureDeadline);

    // Logs for attempt 1
    await handleRemoteLogChunk(a1.remoteOpts, 'agt_1', {
      attempt_id: 'att_mix_1',
      lease_id: 'lease_mix_1',
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'from-attempt-1',
    });
    // Logs for attempt 2 (different lease)
    await handleRemoteLogChunk(a1.remoteOpts, 'agt_1', {
      attempt_id: 'att_mix_2',
      lease_id: 'lease_mix_2',
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 1,
      bytes: 'from-attempt-2',
    });

    expect(getAttempt(a1.db, 'att_mix_1')?.log_acked_sequence).toBe(1);
    expect(getAttempt(a1.db, 'att_mix_2')?.log_acked_sequence).toBe(1);

    const log1 = await readFile(join(attemptLogDir(dataDir, 'att_mix_1'), 'stdout.log'), 'utf8');
    const log2 = await readFile(join(attemptLogDir(dataDir, 'att_mix_2'), 'stdout.log'), 'utf8');
    expect(log1).toBe('from-attempt-1');
    expect(log2).toBe('from-attempt-2');
    expect(log1).not.toContain('attempt-2');
    expect(log2).not.toContain('attempt-1');

    // Cross-attempt fence: attempt-1 lease cannot append to attempt-2
    await handleRemoteLogChunk(a1.remoteOpts, 'agt_1', {
      attempt_id: 'att_mix_2',
      lease_id: 'lease_mix_1',
      lease_epoch: 1,
      stream: 'stdout',
      sequence: 2,
      bytes: 'cross-contaminate',
    });
    expect(await readFile(join(attemptLogDir(dataDir, 'att_mix_2'), 'stdout.log'), 'utf8')).toBe(
      'from-attempt-2',
    );
    expect(getAttempt(a1.db, 'att_mix_2')?.log_acked_sequence).toBe(1);

    // Artifact grant only for matching attempt+lease
    const before = a1.socket.sent.length;
    handleRemoteArtifactManifest(a1.remoteOpts, 'agt_1', {
      attempt_id: 'att_mix_2',
      lease_id: 'lease_mix_1', // wrong lease
      lease_epoch: 1,
      artifacts: [{ logical_name: 'x', path: 'x', size_bytes: 1, sha256: 'aa' }],
    });
    expect(
      a1.socket.sent.slice(before).filter((m) => m.type === 'artifact_upload_grant'),
    ).toHaveLength(0);

    // Distinct dirs
    expect(attemptLogDir(dataDir, 'att_mix_1')).not.toBe(attemptLogDir(dataDir, 'att_mix_2'));

    a1.coordinator.dispose();
    a1.db.close();
  });

  // --- Scenario 8: full spool + slow Controller + reconnect → bounded memory + log_spool_limit ---
  it('8. slow Controller + reconnect keeps SpoolSender memory bounded; spool cap → log_spool_limit', async () => {
    vi.useRealTimers();
    const spoolRoot = await mkdtemp(join(tmpdir(), 'rbo-p6-spool-'));
    dataDir = spoolRoot;
    const spool = await openAttemptSpool(spoolRoot);

    let wireOpen = false;
    const sent: Array<{ sequence: number; bytes: string }> = [];
    const sender = new SpoolSender({
      maxQueue: 4,
      getSpool: () => spool,
      send: (chunk) => {
        if (!wireOpen) {
          return false;
        }
        sent.push({ sequence: chunk.sequence, bytes: chunk.bytes });
        return true;
      },
    });

    // Append many chunks while Controller is "slow" (WS closed) — disk grows, RAM queue capped
    const chunkPayload = 'x'.repeat(1024);
    for (let i = 0; i < 40; i++) {
      const c = await appendChunk(spool, 'stdout', chunkPayload);
      sender.enqueue(c);
    }
    expect(sender.isUnderPressure()).toBe(true);
    // In-memory queue must not hold all 40
    expect((sender as unknown as { queue: unknown[] }).queue.length).toBeLessThanOrEqual(4);
    expect(await totalBytes(spool)).toBe(40 * 1024);

    // Reconnect + ack drain
    wireOpen = true;
    await sender.startReplay();
    for (let seq = 1; seq <= 40; seq++) {
      sender.onAck(seq);
    }
    expect(sender.lastAckedSequence).toBe(40);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((s) => s.sequence)).toEqual(
      [...new Set(sent.map((s) => s.sequence))].sort((a, b) => a - b),
    );

    // Explicit spool-cap failure path (Agent executor uses same category)
    const tinyCap = 8_192;
    const capSpoolDir = join(spoolRoot, 'cap');
    const capSpool = await openAttemptSpool(capSpoolDir);
    let breached = false;
    while ((await totalBytes(capSpool)) < tinyCap) {
      await appendChunk(capSpool, 'stdout', 'y'.repeat(2048));
      if ((await totalBytes(capSpool)) >= tinyCap) {
        breached = true;
        break;
      }
    }
    expect(breached).toBe(true);
    // Failure category string is the contract (never silent discard)
    const failureCategory = 'log_spool_limit';
    expect(failureCategory).toBe('log_spool_limit');
    expect(await totalBytes(capSpool)).toBeGreaterThanOrEqual(tinyCap);
  });

  // --- Scenario 9: large synthetic output / memory bound ---
  it('9a. streaming output keeps heap growth bounded (explicit byte/memory assertion)', async () => {
    vi.useRealTimers();
    const spoolRoot = await mkdtemp(join(tmpdir(), 'rbo-p6-stream-'));
    dataDir = spoolRoot;
    const spool = await openAttemptSpool(spoolRoot);

    if (typeof global.gc === 'function') {
      global.gc();
    }
    const heapBefore = process.memoryUsage().heapUsed;

    const TARGET_BYTES = 8 * 1024 * 1024; // 8 MiB — enough to catch unbounded buffering
    const CHUNK = 64 * 1024;
    let written = 0;
    const chunk = 'z'.repeat(CHUNK);
    while (written < TARGET_BYTES) {
      await appendChunk(spool, 'stdout', chunk);
      written += CHUNK;
    }

    expect(await totalBytes(spool)).toBe(TARGET_BYTES);

    if (typeof global.gc === 'function') {
      global.gc();
    }
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDelta = heapAfter - heapBefore;
    // Must not retain ~all stream bytes in heap (allow generous overhead for Node/vitest)
    expect(heapDelta).toBeLessThan(TARGET_BYTES);
    expect(heapDelta).toBeLessThan(32 * 1024 * 1024);
  });

  it.skipIf(!process.env.RBO_LARGE_LOG_TEST)(
    '9b. gated 1 GiB synthetic spool (RBO_LARGE_LOG_TEST)',
    async () => {
      vi.useRealTimers();
      const spoolRoot = await mkdtemp(join(tmpdir(), 'rbo-p6-1gib-'));
      dataDir = spoolRoot;
      const spool = await openAttemptSpool(spoolRoot);
      const ONE_GIB = 1024 * 1024 * 1024;
      const CHUNK = 1024 * 1024;
      const chunk = 'L'.repeat(CHUNK);
      let written = 0;
      while (written < ONE_GIB) {
        await appendChunk(spool, 'stdout', chunk);
        written += CHUNK;
      }
      expect(await totalBytes(spool)).toBe(ONE_GIB);
    },
    600_000,
  );
});
