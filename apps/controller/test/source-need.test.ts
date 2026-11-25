import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { ensureControllerIdentity } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleRemoteSourceNeed } from '../src/execution/remote-execution.js';
import { attemptTransferDir, captureAndPersistSnapshot } from '../src/execution/runner.js';
import { abortAgentTransfers, handleDataPlaneRequest } from '../src/http/data-plane.js';
import { createJob, getJob, persistSnapshot, transitionJobState } from '../src/jobs/lifecycle.js';
import type { ControllerDatabase } from '../src/storage/database.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

const execFileAsync = promisify(execFile);

describe('Controller source_need → bundle_download', () => {
  let tempDir: string;
  let db: ControllerDatabase;
  let identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;
  let fixture: Awaited<ReturnType<typeof createGitFixtureRepo>>;

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'tmp',
      `test-source-need-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
    db = openDatabase(join(tempDir, 'controller.db'));
    migrateToLatest(db);
    identity = await ensureControllerIdentity(tempDir);
    fixture = await createGitFixtureRepo({
      committed: [{ path: 'hello.txt', content: 'hello' }],
    });
    await import('node:child_process').then(({ execFile }) =>
      import('node:util').then(({ promisify }) =>
        promisify(execFile)(
          'git',
          ['remote', 'add', 'origin', 'https://github.com/testuser/rbo.git'],
          {
            cwd: fixture.root,
            windowsHide: true,
          },
        ),
      ),
    );
  });

  afterEach(async () => {
    await fixture.cleanup();
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function generationPath(candidatePath: string): string {
    return candidatePath.replace(/\.candidate-[^\\/]+$/, '');
  }

  async function publishCapture(capture: Awaited<ReturnType<typeof captureAndPersistSnapshot>>) {
    const candidatePaths = [
      capture.archivePath,
      capture.manifestPath,
      capture.secretWarningsPath,
      capture.gitSourceRequirementsPath,
    ];
    await Promise.all(candidatePaths.map((path) => rename(path, generationPath(path))));
    persistSnapshot(db, {
      snapshotId: capture.snapshotId,
      contentId: capture.contentId,
      repoId: capture.repoId,
      baseCommit: capture.baseCommit,
      dirty: true,
      manifestPath: generationPath(capture.manifestPath),
      payloadPath: generationPath(capture.archivePath),
      sizeBytes: capture.sizeBytes,
      sha256: capture.sha256,
    });
  }

  async function prepareSourceAttempt(suffix: string, full = false) {
    const jobId = `job_fallback_${suffix}`;
    const attemptId = `att_fallback_${suffix}`;
    const agentId = `ag_fallback_${suffix}`;
    const leaseId = `lease_fallback_${suffix}`;
    const request = {
      client_request_id: `req_fallback_${suffix}`,
      source: {
        project_root: fixture.root,
        cwd: '.',
        ...(full ? { snapshot_mode: 'full' as const } : {}),
      },
      execution: { shell: 'bash' as const, script: 'true' },
    };
    const job = createJob(db, {
      jobId,
      clientId: 'client',
      clientRequestId: request.client_request_id,
      request,
      initialState: 'preparing_source',
    });
    transitionJobState(db, job.id, 'preparing_source');
    const capture = await captureAndPersistSnapshot(
      {
        db,
        dataDir: tempDir,
        allowedProjectRoots: [fixture.root],
        allowedArtifactDestinations: [fixture.root],
        remoteCapable: true,
        gitAllowlist: {
          schemes: ['https'],
          hosts: ['github.com'],
          repository_prefixes: ['testuser/'],
        },
      },
      job.id,
      request,
      1,
    );
    await publishCapture(capture);
    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES (?, ?, 'localhost', 'idle', '{}', datetime('now'))`,
    ).run(agentId, agentId);
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, ?, 1, ?, ?, 1, ?, 'preparing_source')`,
    ).run(attemptId, job.id, agentId, leaseId, new Date(Date.now() + 3_600_000).toISOString());
    db.prepare('UPDATE jobs SET snapshot_id = ? WHERE id = ?').run(capture.snapshotId, job.id);

    return { jobId, attemptId, agentId, leaseId, capture };
  }

  it.each(['full_snapshot_required', 'repo_fetch_failed'] as const)(
    'fails the original overlay without capturing the live workspace after %s',
    async (reason) => {
      const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const socket = {
        readyState: 1,
        OPEN: 1,
        send: (raw: string) =>
          sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> }),
      };
      const attempt = await prepareSourceAttempt(reason);
      await writeFile(join(fixture.root, 'hello.txt'), 'changed after submission');

      await handleRemoteSourceNeed(
        {
          db,
          identity,
          dataDir: tempDir,
          connectedAgents: new Map([
            [
              attempt.agentId,
              {
                agentId: attempt.agentId,
                socket: socket as never,
                protocolVersion: 1,
                lastHeartbeatAt: Date.now(),
              },
            ],
          ]),
          serverPort: 7411,
        },
        attempt.agentId,
        {
          attempt_id: attempt.attemptId,
          lease_id: attempt.leaseId,
          lease_epoch: 1,
          reason,
        },
      );

      expect(sent).toEqual([
        expect.objectContaining({
          type: 'reconcile_decision',
          payload: expect.objectContaining({
            action: 'terminate_stale',
            lease_id: attempt.leaseId,
          }),
        }),
      ]);
      expect(getJob(db, attempt.jobId)).toMatchObject({
        state: 'completed',
        outcome: 'failed',
        failure_category: 'repo_fetch',
        failure_message: expect.stringContaining('snapshot_mode=full'),
      });
      await expect(access(attemptTransferDir(tempDir, attempt.attemptId))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('serves the explicitly selected full snapshot from submission on a retry', async () => {
    const { attemptId, agentId, leaseId, capture } = await prepareSourceAttempt('full', true);
    await writeFile(join(fixture.root, 'hello.txt'), 'changed after submission');
    const transferDir = attemptTransferDir(tempDir, attemptId);
    await mkdir(transferDir, { recursive: true });
    await writeFile(join(transferDir, 'snapshot.tar.zst'), 'obsolete transfer data');

    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const socket = { readyState: 1, OPEN: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    await handleRemoteSourceNeed(
      {
        db,
        identity,
        dataDir: tempDir,
        serverPort: 7411,
        connectedAgents: new Map([
          [
            agentId,
            { agentId, socket: socket as never, protocolVersion: 1, lastHeartbeatAt: Date.now() },
          ],
        ]),
      },
      agentId,
      {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: 1,
        reason: 'full_snapshot_required',
      },
    );
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'prepare_source',
        payload: expect.objectContaining({ source_mode: 'full', expected_sha256: capture.sha256 }),
      }),
    ]);

    const chunks: Buffer[] = [];
    const res = Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
      {
        writeHead(status: number) {
          expect(status).toBe(200);
        },
      },
    ) as unknown as ServerResponse;
    const req = {
      method: 'GET',
      url: `/data/v1/attempts/${attemptId}/snapshot`,
      headers: { authorization: `Bearer ${sent[0]?.payload.data_token}` },
    } as unknown as IncomingMessage;
    await expect(
      handleDataPlaneRequest(req, res, { identity, db, dataDir: tempDir }),
    ).resolves.toBe(true);
    expect(Buffer.concat(chunks)).toEqual(await readFile(generationPath(capture.archivePath)));
  });

  it('offers and streams only the captured commit after the checkout HEAD advances', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (raw: string) => {
        const frame = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
        sent.push(frame);
      },
    };

    const job = createJob(db, {
      jobId: 'job_1',
      clientId: 'client',
      clientRequestId: 'req_1',
      request: {
        client_request_id: 'req_1',
        source: { project_root: fixture.root, cwd: '.' },
        execution: { shell: 'bash', script: 'true' },
      },
      initialState: 'preparing_source',
    });
    transitionJobState(db, job.id, 'preparing_source');

    const capture = await captureAndPersistSnapshot(
      {
        db,
        dataDir: tempDir,
        allowedProjectRoots: [fixture.root],
        allowedArtifactDestinations: [fixture.root],
        remoteCapable: true,
        gitAllowlist: {
          schemes: ['https'],
          hosts: ['github.com'],
          repository_prefixes: ['testuser/'],
        },
      },
      job.id,
      {
        client_request_id: 'req_1',
        source: { project_root: fixture.root, cwd: '.' },
        execution: { shell: 'bash', script: 'true' },
      },
      1,
    );
    await publishCapture(capture);

    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES ('ag_1', 'ag-1', 'localhost', 'idle', '{}', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES ('att_1', ?, 1, 'ag_1', 'lease_1', 1, ?, 'preparing_source')`,
    ).run(job.id, new Date(Date.now() + 3_600_000).toISOString());

    db.prepare('UPDATE jobs SET snapshot_id = ? WHERE id = ?').run(capture.snapshotId, job.id);

    const manifest = JSON.parse(await readFile(generationPath(capture.manifestPath), 'utf8'));
    expect(manifest.payload.mode).toBe('git_overlay');
    const git = (...args: string[]) =>
      execFileAsync('git', args, { cwd: fixture.root, windowsHide: true });
    await git('commit', '--allow-empty', '-m', 'Later workspace commit');
    const refsBefore = await git('show-ref');
    expect((await git('rev-parse', 'HEAD')).stdout.trim()).not.toBe(manifest.repo.base_commit);

    await handleRemoteSourceNeed(
      {
        db,
        identity,
        dataDir: tempDir,
        connectedAgents: new Map([
          [
            'ag_1',
            {
              agentId: 'ag_1',
              socket: socket as never,
              protocolVersion: 1,
              lastHeartbeatAt: Date.now(),
            },
          ],
        ]),
        serverPort: 7411,
      },
      'ag_1',
      {
        attempt_id: 'att_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        reason: 'base_commit_missing',
      },
    );

    const bundleFrame = sent.find((frame) => frame.type === 'bundle_download');
    expect(bundleFrame).toBeDefined();
    expect(bundleFrame?.payload.expected_size_bytes).toBeGreaterThan(0);
    expect(bundleFrame?.payload.expected_sha256).toMatch(/^[0-9a-f]{64}$/);
    const bundlePath = join(attemptTransferDir(tempDir, 'att_1'), 'bundle', 'bundle.gitbundle');
    const heads = await git('bundle', 'list-heads', bundlePath);
    expect(heads.stdout.trim().split(/\r?\n/)).toEqual([
      `${manifest.repo.base_commit} refs/heads/rbo-captured-base`,
    ]);
    expect((await git('show-ref')).stdout).toBe(refsBefore.stdout);

    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    let headers: Record<string, string | number> = {};
    const res = Object.assign(writable, {
      writeHead(status: number, values: Record<string, string | number>) {
        expect(status).toBe(200);
        headers = values;
      },
    }) as unknown as ServerResponse;
    const req = {
      method: 'GET',
      url: '/data/v1/attempts/att_1/bundle',
      headers: { authorization: `Bearer ${bundleFrame?.payload.data_token}` },
    } as unknown as IncomingMessage;
    await expect(
      handleDataPlaneRequest(req, res, { identity, db, dataDir: tempDir }),
    ).resolves.toBe(true);
    expect(headers).toMatchObject({
      'content-length': bundleFrame?.payload.expected_size_bytes,
      'x-rbo-sha256': bundleFrame?.payload.expected_sha256,
    });
    expect(Buffer.concat(chunks)).toEqual(await readFile(bundlePath));

    const started = Promise.withResolvers<void>();
    const slowResponse = Object.assign(
      new Writable({
        write() {
          started.resolve();
        },
      }),
      { writeHead() {} },
    );
    const inFlight = handleDataPlaneRequest(req, slowResponse as unknown as ServerResponse, {
      identity,
      db,
      dataDir: tempDir,
    });
    await started.promise;
    abortAgentTransfers(db, 'ag_1');
    await expect(inFlight).resolves.toBe(true);
    expect(slowResponse.destroyed).toBe(true);
  });

  it('fails prepare when git bundle exceeds maxGitBundleBytes', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (raw: string) => {
        const frame = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
        sent.push(frame);
      },
    };

    const job = createJob(db, {
      jobId: 'job_bundle_limit',
      clientId: 'client',
      clientRequestId: 'req_bundle_limit',
      request: {
        client_request_id: 'req_bundle_limit',
        source: { project_root: fixture.root, cwd: '.' },
        execution: { shell: 'bash', script: 'true' },
      },
      initialState: 'preparing_source',
    });
    transitionJobState(db, job.id, 'preparing_source');

    const capture = await captureAndPersistSnapshot(
      {
        db,
        dataDir: tempDir,
        allowedProjectRoots: [fixture.root],
        allowedArtifactDestinations: [fixture.root],
        remoteCapable: true,
        gitAllowlist: {
          schemes: ['https'],
          hosts: ['github.com'],
          repository_prefixes: ['testuser/'],
        },
      },
      job.id,
      {
        client_request_id: 'req_bundle_limit',
        source: { project_root: fixture.root, cwd: '.' },
        execution: { shell: 'bash', script: 'true' },
      },
      1,
    );
    await publishCapture(capture);

    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES ('ag_limit', 'ag-limit', 'localhost', 'idle', '{}', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES ('att_limit', ?, 1, 'ag_limit', 'lease_limit', 1, ?, 'preparing_source')`,
    ).run(job.id, new Date(Date.now() + 3_600_000).toISOString());

    db.prepare('UPDATE jobs SET snapshot_id = ? WHERE id = ?').run(capture.snapshotId, job.id);

    await handleRemoteSourceNeed(
      {
        db,
        identity,
        dataDir: tempDir,
        connectedAgents: new Map([
          [
            'ag_limit',
            {
              agentId: 'ag_limit',
              socket: socket as never,
              protocolVersion: 1,
              lastHeartbeatAt: Date.now(),
            },
          ],
        ]),
        serverPort: 7411,
        maxGitBundleBytes: 1,
      },
      'ag_limit',
      {
        attempt_id: 'att_limit',
        lease_id: 'lease_limit',
        lease_epoch: 1,
        reason: 'base_commit_missing',
      },
    );

    expect(sent.some((frame) => frame.type === 'bundle_download')).toBe(false);
    const attempt = db
      .prepare('SELECT state, outcome FROM job_attempts WHERE id = ?')
      .get('att_limit') as { state: string; outcome: string | null };
    expect(attempt.state).toBe('completed');
    expect(attempt.outcome).toBe('failed');
    const jobRow = db.prepare('SELECT failure_message FROM jobs WHERE id = ?').get(job.id) as {
      failure_message: string | null;
    };
    expect(jobRow.failure_message).toMatch(/exceeds maximum 1 bytes/);
  });

  // A non-allowlisted remote makes overlay capture impossible. Falling back to a
  // full snapshot silently would upload the whole working tree, so the fallback
  // is opt-in: default refuses with an actionable reason, opt-in degrades to full.
  function disallowedRemoteCtx(jobSuffix: string, allowFullSnapshotFallback?: boolean) {
    return {
      db,
      dataDir: tempDir,
      allowedProjectRoots: [fixture.root],
      allowedArtifactDestinations: [fixture.root],
      remoteCapable: true,
      gitAllowlist: {
        schemes: ['https'],
        hosts: ['github.com'],
        repository_prefixes: ['other-user/'],
      },
      ...(allowFullSnapshotFallback === undefined ? {} : { allowFullSnapshotFallback }),
      jobSuffix,
    };
  }

  function disallowedRequest(clientRequestId: string) {
    return {
      client_request_id: clientRequestId,
      source: { project_root: fixture.root, cwd: '.' },
      execution: { shell: 'bash', script: 'true' },
    };
  }

  it('refuses capture when the repository URL is not allowlisted and fallback is default-off', async () => {
    const job = createJob(db, {
      jobId: 'job_disallowed_strict',
      clientId: 'client',
      clientRequestId: 'req_disallowed_strict',
      request: disallowedRequest('req_disallowed_strict'),
      initialState: 'created',
    });

    const { jobSuffix: _unused, ...ctx } = disallowedRemoteCtx('strict');
    await expect(
      captureAndPersistSnapshot(ctx, job.id, disallowedRequest('req_disallowed_strict'), 1),
    ).rejects.toThrow(
      /no fetch remote is allowed by git_allowlist[\s\S]*disabled by default[\s\S]*allow_full_snapshot_fallback/,
    );
  });

  it('falls back to a full snapshot when allow_full_snapshot_fallback is opted in', async () => {
    const job = createJob(db, {
      jobId: 'job_disallowed',
      clientId: 'client',
      clientRequestId: 'req_disallowed',
      request: disallowedRequest('req_disallowed'),
      initialState: 'created',
    });

    const { jobSuffix: _unused, ...ctx } = disallowedRemoteCtx('optin', true);
    const capture = await captureAndPersistSnapshot(
      ctx,
      job.id,
      disallowedRequest('req_disallowed'),
      1,
    );

    const manifest = JSON.parse(await readFile(capture.manifestPath, 'utf8'));
    expect(manifest.payload.mode).toBe('full');
    expect(capture.manifestPath).toContain('.candidate-');
    expect(capture.contentId).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get()).toMatchObject({ count: 0 });
  });
});
