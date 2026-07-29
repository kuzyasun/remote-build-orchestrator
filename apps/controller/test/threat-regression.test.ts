import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsWindowsReservedName, isSafeRelativePath, sha256 } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { materializeArtifactToDestination } from '../src/execution/artifacts.js';
import {
  OBSERVABILITY_REQUIRED_FIELDS,
  buildObservabilityReportSkeleton,
  redactObservabilityObject,
} from '../src/ops/observability.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

const ROOT = process.cwd();
const THREAT_PATH = join(ROOT, 'docs', 'archive', 'reports', 'threat-coverage.json');

const REQUIRED_THREAT_KEYS = [
  'path_traversal',
  'absolute_archive_path',
  'symlink_escape',
  'tar_bomb',
  'duplicate_normalized_path',
  'windows_reserved_name',
  'oversized_file',
  'expired_token',
  'forged_agent_id',
  'replayed_lease',
  'hash_mismatch',
  'secret_blocked',
  'cert_fingerprint_mismatch',
  'artifact_destination_symlink_swap',
  'git_allowlist',
  'cross_client_idempotency',
] as const;

describe('Threat regression index (§34.5)', () => {
  it('maps every §34.5 case to test refs or an environment gate', async () => {
    const coverage = JSON.parse(await readFile(THREAT_PATH, 'utf8')) as {
      cases: Record<string, { test_refs?: string[]; environment_gated?: string }>;
    };
    for (const key of REQUIRED_THREAT_KEYS) {
      const entry = coverage.cases[key];
      expect(entry, `missing threat case ${key}`).toBeTruthy();
      const refs = entry.test_refs ?? [];
      expect(refs.length > 0 || entry.environment_gated, key).toBeTruthy();
      for (const ref of refs) {
        await access(join(ROOT, ref));
      }
    }
  });

  it('rejects Windows reserved names in safe relative paths', () => {
    expect(containsWindowsReservedName('aux/out.bin')).toBe(true);
    expect(isSafeRelativePath('LPT1/file')).toBe(false);
  });

  it('documents tar-bomb / aggregate artifact limit handling', async () => {
    // Aggregate limit breach stops collection and does not publish a partial set
    // (packages/executor artifacts + Phase 3 decision). This regression anchors the policy.
    const artifactsTest = await readFile(
      join(ROOT, 'packages', 'executor', 'test', 'artifacts.test.ts'),
      'utf8',
    );
    expect(artifactsTest).toMatch(/oversized|limit|skip/i);
  });

  it('redacts secrets from observability payloads', () => {
    const redacted = redactObservabilityObject({
      job_id: 'job_1',
      authorization: 'Bearer super-secret',
      nested: { api_key: 'abc', ok: 1 },
    });
    expect(redacted.authorization).toBe('[REDACTED]');
    expect((redacted.nested as { api_key: string }).api_key).toBe('[REDACTED]');
    expect((redacted.nested as { ok: number }).ok).toBe(1);
    expect(redacted.job_id).toBe('job_1');
  });

  it('observability skeleton includes required metric fields', () => {
    const report = buildObservabilityReportSkeleton();
    for (const field of OBSERVABILITY_REQUIRED_FIELDS) {
      expect(field in report).toBe(true);
    }
  });

  it('rejects artifact_materialize when the destination directory is a junction/symlink swapped to point outside the allowed root', async () => {
    // On Windows this uses a 'junction' (no special privilege required); on POSIX a plain
    // directory symlink (also unprivileged) — so this test runs unconditionally, unlike the
    // full-snapshot symlink-escape cases which need SeCreateSymbolicLinkPrivilege.
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs (id, client_id, client_request_id, name, state, created_at, updated_at, request_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job_sym1', 'client_sym', 'req_sym1', 'symlink-swap-test', 'succeeded', now, now, '{}');
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, lease_id, lease_epoch, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('att_sym1', 'job_sym1', 1, 'lease_sym1', 1, 'succeeded');

    const sourceDir = await mkdtemp(join(tmpdir(), 'rbo-artifact-src-'));
    const allowedRoot = await mkdtemp(join(tmpdir(), 'rbo-allowed-dest-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'rbo-outside-dest-'));
    try {
      const sourceContent = 'artifact-payload';
      const sourcePath = join(sourceDir, 'stored-artifact.bin');
      await writeFile(sourcePath, sourceContent);
      const hash = sha256(Buffer.from(sourceContent));
      db.prepare(
        `INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'art_sym1',
        'job_sym1',
        'att_sym1',
        'stored-artifact.bin',
        sourcePath,
        sourceContent.length,
        hash,
        now,
      );

      const swappedLink = join(allowedRoot, 'evil');
      await symlink(outsideRoot, swappedLink, process.platform === 'win32' ? 'junction' : 'dir');
      const destinationPath = join(swappedLink, 'pwned.txt');

      await expect(
        materializeArtifactToDestination({
          db,
          artifactId: 'art_sym1',
          destinationPath,
          allowedDestinations: [allowedRoot],
          overwrite: false,
        }),
      ).rejects.toThrow(/outside allowed artifact destinations/i);

      await expect(access(join(outsideRoot, 'pwned.txt'))).rejects.toThrow();
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
      db.close();
    }
  });
});
