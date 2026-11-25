import { expect, it } from 'vitest';
import {
  expireStaleLeases,
  handleRemoteCleanupComplete,
  handleRemoteJobExit,
} from '../src/execution/remote-execution.js';
import { handleJobRun } from '../src/jobs/job-run.js';
import {
  createAttempt,
  createJob,
  getJob,
  transitionAttemptState,
  transitionJobState,
  updateAttempt,
} from '../src/jobs/lifecycle.js';
import { handleJobArtifacts } from '../src/jobs/submit.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';

it('reports partially stored required artifacts without changing the successful process outcome', async () => {
  const db = openDatabase(':memory:');
  try {
    migrateToLatest(db);
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'request',
      initialState: 'running',
      request: {
        client_request_id: 'request',
        source: { project_root: '/workspace', cwd: '.' },
        execution: { script: 'echo done' },
        artifacts: [{ glob: 'outputs/*.txt', required: true }],
      },
    });
    const attempt = createAttempt(db, job.id, 1);
    transitionAttemptState(db, attempt.id, 'completed', { outcome: 'succeeded' });
    transitionJobState(db, job.id, 'completed', { outcome: 'succeeded', exit_code: 0 });
    db.prepare('UPDATE job_attempts SET artifact_collection_json = ? WHERE id = ?').run(
      JSON.stringify({
        rules: [{ matched_count: 2, collected_count: 2, skipped_count: 0, skip_reasons: [] }],
      }),
      attempt.id,
    );
    db.prepare(
      `INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at)
       VALUES ('art_1', ?, ?, 'outputs/one.txt', '/data/art_1', 3, ?, ?)`,
    ).run(job.id, attempt.id, 'a'.repeat(64), nowIso());

    const listing = handleJobArtifacts(db, job.id);
    expect(listing.artifact_rule_results).toEqual([
      {
        glob: 'outputs/*.txt',
        required: true,
        status: 'not_stored',
        stored_count: 1,
        collected_count: 2,
        matched_count: 2,
        skipped_count: 0,
      },
    ]);
    expect(listing.artifacts).toHaveLength(1);
    const result = await handleJobRun(
      {
        db,
        clientId: 'client',
        controllerIdentity: {} as never,
        dataDir: '',
        allowedProjectRoots: [],
        allowedArtifactDestinations: [],
      },
      { job_id: job.id },
    );
    expect(result).toMatchObject({
      outcome: 'succeeded',
      exit_code: 0,
      missing_required_artifacts: [
        { glob: 'outputs/*.txt', status: 'not_stored', matched_count: 2, collected_count: 2 },
      ],
    });
  } finally {
    db.close();
  }
});

it.each(['agent', 'watchdog', 'watchdog_with_summary'] as const)(
  'reports artifact recovery ending via %s and preserves the recorded process result',
  async (completion) => {
    const db = openDatabase(':memory:');
    try {
      migrateToLatest(db);
      const job = createJob(db, {
        clientId: 'client',
        clientRequestId: 'request_interrupted',
        initialState: 'running',
        request: {
          client_request_id: 'request_interrupted',
          source: { project_root: '/workspace', cwd: '.' },
          execution: { script: 'echo done' },
          artifacts: [{ glob: 'outputs/*.txt', required: true }],
        },
      });
      db.prepare(
        `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES ('agt_1', 'agent', 'host', 'idle', '{}', ?)`,
      ).run(nowIso());
      const attempt = createAttempt(db, job.id, 1);
      updateAttempt(db, attempt.id, {
        agent_id: 'agt_1',
        state: 'running',
        lease_deadline: new Date(Date.now() + 30_000).toISOString(),
      });
      const remoteOpts = {
        db,
        identity: {} as never,
        dataDir: '',
        connectedAgents: new Map(),
        serverPort: 0,
      };
      const lease = {
        attempt_id: attempt.id,
        lease_id: attempt.lease_id,
        lease_epoch: attempt.lease_epoch,
      };
      handleRemoteJobExit(remoteOpts, 'agt_1', { ...lease, exit_code: 0, outcome: 'succeeded' });
      db.prepare(
        `INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at)
       VALUES ('art_1', ?, ?, 'outputs/one.txt', '/data/art_1', 3, ?, ?)`,
      ).run(job.id, attempt.id, 'a'.repeat(64), nowIso());
      const hasSummary = completion === 'watchdog_with_summary';
      if (hasSummary) {
        db.prepare('UPDATE job_attempts SET artifact_collection_json = ? WHERE id = ?').run(
          JSON.stringify({
            rules: [{ matched_count: 2, collected_count: 2, skipped_count: 0, skip_reasons: [] }],
          }),
          attempt.id,
        );
      }
      if (completion === 'agent') {
        await handleRemoteCleanupComplete(remoteOpts, 'agt_1', {
          ...lease,
          exit_code: null,
          timed_out: false,
          artifact_staging_interrupted: true,
          cleanup_interrupted: true,
        });
      } else {
        updateAttempt(db, attempt.id, {
          lease_deadline: new Date(Date.now() - 1000).toISOString(),
        });
        expireStaleLeases(db);
      }

      expect(getJob(db, job.id)).toMatchObject({
        state: 'completed',
        outcome: 'succeeded',
        exit_code: 0,
        failure_message: null,
      });
      const status = hasSummary ? 'not_stored' : 'interrupted';
      const listing = handleJobArtifacts(db, job.id);
      expect(listing).toMatchObject({
        collection_reported: hasSummary,
        artifacts: [{ logical_name: 'outputs/one.txt' }],
        artifact_rule_results: [
          {
            glob: 'outputs/*.txt',
            required: true,
            stored_count: 1,
            status,
            ...(hasSummary ? { matched_count: 2, collected_count: 2 } : {}),
          },
        ],
      });
      expect(listing.collection_interrupted).toBe(hasSummary ? undefined : true);
      const result = await handleJobRun(
        {
          db,
          clientId: 'client',
          controllerIdentity: {} as never,
          dataDir: '',
          allowedProjectRoots: [],
          allowedArtifactDestinations: [],
        },
        { job_id: job.id },
      );
      expect(result).toMatchObject({
        outcome: 'succeeded',
        exit_code: 0,
        missing_required_artifacts: [{ glob: 'outputs/*.txt', status }],
      });
      expect(result.collection_interrupted).toBe(hasSummary ? undefined : true);
      expect(result.artifact_hint).toBe(
        hasSummary
          ? undefined
          : 'Artifact collection did not finish before attempt recovery ended.',
      );
    } finally {
      db.close();
    }
  },
);
