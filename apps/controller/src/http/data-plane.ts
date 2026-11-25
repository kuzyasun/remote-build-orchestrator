import { createHash } from 'node:crypto';
import { createWriteStream, renameSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ControllerIdentity } from '@rbo/shared';
import { createLogger, generateId, isSafeRelativePath, sha256File } from '@rbo/shared';
import { isAgentRevoked } from '../agents/registry.js';
import { attemptBaseDir, attemptTransferDir } from '../execution/runner.js';
import { verifyDataToken } from '../security/data-tokens.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import { parseRequestUrl } from './request-url.js';

const logger = createLogger('controller.data-plane');
const transferResponses = new WeakMap<ControllerDatabase, Map<string, Set<ServerResponse>>>();

function trackAgentTransfer(
  db: ControllerDatabase,
  agentId: string,
  response: ServerResponse,
): () => void {
  let agents = transferResponses.get(db);
  if (!agents) {
    agents = new Map();
    transferResponses.set(db, agents);
  }
  let responses = agents.get(agentId);
  if (!responses) {
    responses = new Set();
    agents.set(agentId, responses);
  }
  responses.add(response);
  return () => {
    responses.delete(response);
    if (responses.size === 0 && agents.get(agentId) === responses) {
      agents.delete(agentId);
    }
  };
}

/** Stop responses already authorized before the Agent's revocation was recorded. */
export function abortAgentTransfers(db: ControllerDatabase, agentId: string): void {
  const agents = transferResponses.get(db);
  const responses = agents?.get(agentId);
  agents?.delete(agentId);
  for (const response of responses ?? []) {
    response.destroy();
  }
}

export interface DataPlaneOptions {
  db: ControllerDatabase;
  identity: ControllerIdentity;
  dataDir: string;
}

interface ArtifactExpectation {
  size_bytes: number;
  sha256: string;
}

interface ManifestArtifact extends ArtifactExpectation {
  logical_name: string;
}

/** Expected size/sha256 from artifact_manifest, keyed by attemptId\\0logicalName. */
const artifactExpectations = new Map<string, ArtifactExpectation>();

const DEFAULT_ARTIFACT_CAP_BYTES = 100 * 1024 * 1024;

/**
 * Stream abort limit: reject as soon as bytes exceed the manifest-declared
 * size (and never above the global single-artifact cap).
 */
export function artifactUploadStreamLimit(
  declaredSizeBytes: number,
  globalCapBytes = DEFAULT_ARTIFACT_CAP_BYTES,
): number {
  return Math.min(globalCapBytes, declaredSizeBytes);
}

function expectationKey(attemptId: string, logicalName: string): string {
  return `${attemptId}\0${logicalName}`;
}

/** Persist Agent-declared artifact size/sha256 before issuing upload grants. */
export function registerArtifactExpectations(
  attemptId: string,
  artifacts: Array<{ logical_name: string; size_bytes: number; sha256: string }>,
): void {
  for (const art of artifacts) {
    const key = expectationKey(attemptId, art.logical_name);
    const current = artifactExpectations.get(key);
    if (current?.size_bytes !== art.size_bytes || current.sha256 !== art.sha256) {
      artifactExpectations.set(key, { size_bytes: art.size_bytes, sha256: art.sha256 });
    }
  }
}

export function clearArtifactExpectations(attemptId: string): void {
  const prefix = `${attemptId}\0`;
  for (const key of artifactExpectations.keys()) {
    if (key.startsWith(prefix)) {
      artifactExpectations.delete(key);
    }
  }
}

function remoteArtifactsDir(dataDir: string, attemptId: string): string {
  return join(attemptBaseDir(dataDir, attemptId), 'remote-artifacts');
}

function artifactObjectPath(artifactsDir: string, logicalName: string): string {
  // Hash the exact name independently of case folding or path normalization on the Controller.
  return join(artifactsDir, createHash('sha256').update(logicalName, 'utf16le').digest('hex'));
}

async function artifactObjectMatches(
  path: string,
  expected: ArtifactExpectation,
): Promise<boolean> {
  try {
    const file = await lstat(path);
    return (
      file.isFile() &&
      file.size === expected.size_bytes &&
      (await sha256File(path)) === expected.sha256
    );
  } catch {
    return false;
  }
}

/** Return only manifest artifacts that need a new upload. */
export async function filterMissingArtifacts(
  { db, dataDir }: Pick<DataPlaneOptions, 'db' | 'dataDir'>,
  attemptId: string,
  artifacts: ManifestArtifact[],
  canReconcile: () => boolean,
): Promise<ManifestArtifact[]> {
  const artifactsDir = remoteArtifactsDir(dataDir, attemptId);
  const findStoredPath = db.prepare(
    'SELECT path FROM artifacts WHERE attempt_id = ? AND logical_name = ?',
  );
  const missing: ManifestArtifact[] = [];
  for (const art of artifacts) {
    const destPath = artifactObjectPath(artifactsDir, art.logical_name);
    const stored = findStoredPath.get(attemptId, art.logical_name) as { path: string } | undefined;
    let verifiedPath: string | undefined;
    if (await artifactObjectMatches(destPath, art)) {
      verifiedPath = destPath;
    } else if (
      stored &&
      stored.path !== destPath &&
      (await artifactObjectMatches(stored.path, art))
    ) {
      verifiedPath = stored.path;
    }
    if (!canReconcile()) {
      return [];
    }
    const expected = getArtifactExpectation(attemptId, art.logical_name);
    if (expected?.size_bytes !== art.size_bytes || expected.sha256 !== art.sha256) {
      continue;
    }
    if (verifiedPath) {
      // Recreate the row left behind by a crash after publication and before SQLite commit.
      storeArtifactRecord(db, attemptId, art.logical_name, verifiedPath, art);
    } else {
      missing.push(art);
    }
  }
  return missing;
}

function storeArtifactRecord(
  db: ControllerDatabase,
  attemptId: string,
  logicalName: string,
  filePath: string,
  artifact: ArtifactExpectation,
): void {
  const result = db
    .prepare(
      `INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at)
     SELECT ?, job_id, id, ?, ?, ?, ?, ? FROM job_attempts WHERE id = ?
     ON CONFLICT(attempt_id, logical_name) DO UPDATE SET
       size_bytes = excluded.size_bytes,
       sha256 = excluded.sha256,
       path = excluded.path`,
    )
    .run(
      generateId('art'),
      logicalName,
      filePath,
      artifact.size_bytes,
      artifact.sha256,
      nowIso(),
      attemptId,
    );
  if (result.changes !== 1) {
    throw new Error('Cannot persist an artifact for a missing attempt');
  }
}

export async function readBundleMetadata(
  dir: string,
): Promise<{ sizeBytes: number; sha256: string; baseCommit: string }> {
  const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0 ||
    typeof metadata.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
    typeof metadata.baseCommit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata.baseCommit)
  ) {
    throw new Error('Invalid Git bundle metadata');
  }
  return {
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    baseCommit: metadata.baseCommit,
  };
}

function getArtifactExpectation(
  attemptId: string,
  logicalName: string,
): ArtifactExpectation | undefined {
  return artifactExpectations.get(expectationKey(attemptId, logicalName));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken;
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function authorizeAttemptToken(
  db: ControllerDatabase,
  token: {
    agentId: string;
    jobId: string;
    attemptId: string;
    leaseId: string;
    leaseEpoch: number;
    op: string;
  },
  attemptId: string,
  allowedStates: string[],
): { ok: true } | { ok: false; status: number; message: string } {
  if (token.attemptId !== attemptId) {
    return { ok: false, status: 403, message: 'Token attempt_id mismatch' };
  }
  if (isAgentRevoked(db, token.agentId)) {
    return { ok: false, status: 403, message: 'Agent is revoked' };
  }

  const row = db
    .prepare(
      `SELECT id, job_id, agent_id, lease_id, lease_epoch, lease_deadline, state
       FROM job_attempts WHERE id = ?`,
    )
    .get(attemptId) as
    | {
        id: string;
        job_id: string;
        agent_id: string | null;
        lease_id: string;
        lease_epoch: number;
        lease_deadline: string | null;
        state: string;
      }
    | undefined;

  if (!row) {
    return { ok: false, status: 404, message: 'Attempt not found' };
  }
  if (
    row.agent_id !== token.agentId ||
    row.job_id !== token.jobId ||
    row.lease_id !== token.leaseId ||
    row.lease_epoch !== token.leaseEpoch
  ) {
    return { ok: false, status: 403, message: 'Token lease tuple mismatch' };
  }
  if (row.lease_deadline && Date.parse(row.lease_deadline) <= Date.now()) {
    return { ok: false, status: 403, message: 'Lease expired' };
  }
  if (!allowedStates.includes(row.state)) {
    return {
      ok: false,
      status: 403,
      message: `Attempt state '${row.state}' rejects this operation`,
    };
  }
  return { ok: true };
}

type AttemptAuthorization = ReturnType<typeof authorizeAttemptToken>;

function sendAuthorizationFailure(
  res: ServerResponse,
  auth: Exclude<AttemptAuthorization, { ok: true }>,
): void {
  sendJson(res, auth.status, {
    error: { category: 'validation', message: auth.message, retryable: false },
  });
}

async function streamTransferFile(
  res: ServerResponse,
  input: { path: string; sizeBytes: number; sha256: string; contentType: string },
  authorize: () => AttemptAuthorization,
  trackTransfer: () => () => void,
  transfer: { attemptId: string; kind: 'snapshot' | 'overlay' | 'bundle' },
): Promise<void> {
  try {
    const file = await open(input.path, 'r');
    try {
      const fileStats = await file.stat();
      if (!fileStats.isFile() || fileStats.size !== input.sizeBytes) {
        throw new Error('Transfer file does not match its stored metadata');
      }
      const auth = authorize();
      if (!auth.ok) {
        sendAuthorizationFailure(res, auth);
        return;
      }
      const release = trackTransfer();
      try {
        res.writeHead(200, {
          'content-type': input.contentType,
          'content-length': fileStats.size,
          'x-rbo-sha256': input.sha256,
        });
        if (fileStats.size === 0) {
          res.end();
        } else {
          await pipeline(file.createReadStream({ end: fileStats.size - 1 }), res);
        }
      } finally {
        release();
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    logger.warn('transfer stream failed', { ...transfer, error: String(error) });
    if (!res.headersSent && !res.destroyed) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      sendJson(res, missing ? 404 : 500, {
        error: {
          category: missing ? 'materialization' : 'internal',
          message: `Failed to read ${transfer.kind} file`,
          retryable: !missing,
        },
      });
    }
  }
}

class ArtifactStreamLimitError extends Error {}

export async function handleDataPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DataPlaneOptions,
): Promise<boolean> {
  const url = parseRequestUrl(req.url);
  if (!url) {
    sendJson(res, 400, {
      error: { category: 'validation', message: 'Invalid request target', retryable: false },
    });
    return true;
  }
  if (!url.pathname.startsWith('/data/v1/')) {
    return false;
  }

  const tokenStr = extractToken(req, url);
  if (!tokenStr) {
    sendJson(res, 401, {
      error: { category: 'validation', message: 'Missing data token', retryable: false },
    });
    return true;
  }

  const token = verifyDataToken(options.identity, tokenStr);
  if (!token) {
    sendJson(res, 403, {
      error: { category: 'validation', message: 'Invalid or expired data token', retryable: false },
    });
    return true;
  }
  const authorizeSource = (attemptId: string) =>
    authorizeAttemptToken(options.db, token, attemptId, [
      'preparing_source',
      'transferring_source',
      'materializing',
    ]);
  const trackTransfer = () => trackAgentTransfer(options.db, token.agentId, res);

  // Route 1: GET /data/v1/attempts/:attemptId/snapshot
  const snapshotMatch = /^\/data\/v1\/attempts\/([^/]+)\/snapshot$/.exec(url.pathname);
  if (snapshotMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: { category: 'validation', message: 'GET required', retryable: false },
      });
      return true;
    }
    const attemptId = snapshotMatch[1];
    if (token.op !== 'snapshot_download') {
      sendJson(res, 403, {
        error: {
          category: 'validation',
          message: 'Token claim mismatch for snapshot download',
          retryable: false,
        },
      });
      return true;
    }

    const auth = authorizeSource(attemptId);
    if (!auth.ok) {
      sendAuthorizationFailure(res, auth);
      return true;
    }

    const row = options.db
      .prepare(
        `SELECT s.payload_path, s.size_bytes, s.sha256
         FROM job_attempts a
         JOIN jobs j ON a.job_id = j.id
         JOIN snapshots s ON j.snapshot_id = s.id
         WHERE a.id = ?`,
      )
      .get(attemptId) as { payload_path: string; size_bytes: number; sha256: string } | undefined;

    const payloadPath = row?.payload_path;
    const sizeBytes = row?.size_bytes;
    const sha256 = row?.sha256;

    if (!payloadPath || sizeBytes == null || !sha256) {
      sendJson(res, 404, {
        error: {
          category: 'materialization',
          message: 'Snapshot payload not found',
          retryable: false,
        },
      });
      return true;
    }

    await streamTransferFile(
      res,
      { path: payloadPath, sizeBytes, sha256, contentType: 'application/zstd' },
      () => authorizeSource(attemptId),
      trackTransfer,
      { attemptId, kind: 'snapshot' },
    );
    return true;
  }

  // Route 2: PUT /data/v1/attempts/:attemptId/artifacts/:artifactId
  const artifactMatch = /^\/data\/v1\/attempts\/([^/]+)\/artifacts\/(.+)$/.exec(url.pathname);
  if (artifactMatch) {
    if (req.method !== 'PUT') {
      sendJson(res, 405, {
        error: { category: 'validation', message: 'PUT required', retryable: false },
      });
      return true;
    }
    const attemptId = artifactMatch[1];
    let logicalName: string;
    try {
      logicalName = decodeURIComponent(artifactMatch[2]);
    } catch {
      sendJson(res, 400, {
        error: {
          category: 'artifact_upload',
          message: 'Invalid artifact path encoding',
          retryable: false,
        },
      });
      return true;
    }

    if (token.op !== 'artifact_upload' || token.artifactId !== logicalName) {
      sendJson(res, 403, {
        error: {
          category: 'validation',
          message: 'Token claim mismatch for artifact upload',
          retryable: false,
        },
      });
      return true;
    }

    if (!isSafeRelativePath(logicalName)) {
      sendJson(res, 400, {
        error: {
          category: 'artifact_upload',
          message: 'Artifact logical name must be a safe relative path',
          retryable: false,
        },
      });
      return true;
    }

    const authorizeUpload = () =>
      authorizeAttemptToken(options.db, token, attemptId, ['collecting_artifacts']);
    const auth = authorizeUpload();
    if (!auth.ok) {
      sendAuthorizationFailure(res, auth);
      return true;
    }

    const expected = getArtifactExpectation(attemptId, logicalName);
    if (!expected) {
      sendJson(res, 400, {
        error: {
          category: 'artifact_upload',
          message: 'Artifact was not declared in artifact_manifest',
          retryable: false,
        },
      });
      return true;
    }

    const artifactsDir = remoteArtifactsDir(options.dataDir, attemptId);
    const destPath = artifactObjectPath(artifactsDir, logicalName);
    const hasher = createHash('sha256');
    let sizeCounter = 0;
    const streamLimitBytes = artifactUploadStreamLimit(expected.size_bytes);
    const transferDir = attemptTransferDir(options.dataDir, attemptId);
    let partDir: string | undefined;
    const release = trackTransfer();

    try {
      await mkdir(artifactsDir, { recursive: true });
      await mkdir(transferDir, { recursive: true });
      partDir = await mkdtemp(join(transferDir, '.artifact-upload-'));
      const partPath = join(partDir, 'artifact');
      const checkedBody = async function* () {
        // Keep the request open long enough to report a 413 after stopping the file write.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          sizeCounter += (chunk as Buffer).length;
          if (sizeCounter > streamLimitBytes) {
            throw new ArtifactStreamLimitError();
          }
          hasher.update(chunk as Buffer);
          yield chunk as Buffer;
        }
      };
      await pipeline(checkedBody(), createWriteStream(partPath, { flags: 'wx', mode: 0o600 }));

      const calculatedSha256 = hasher.digest('hex');

      if (sizeCounter !== expected.size_bytes) {
        sendJson(res, 400, {
          error: {
            category: 'artifact_upload',
            message: `Artifact byte count mismatch: got ${sizeCounter}, expected ${expected.size_bytes} from artifact_manifest`,
            retryable: false,
          },
        });
        return true;
      }

      if (calculatedSha256 !== expected.sha256) {
        sendJson(res, 400, {
          error: {
            category: 'snapshot_hash',
            message: 'Artifact SHA-256 mismatch vs artifact_manifest',
            retryable: false,
          },
        });
        return true;
      }

      const finalAuth = authorizeUpload();
      if (!finalAuth.ok) {
        sendAuthorizationFailure(res, finalAuth);
        return true;
      }
      if (getArtifactExpectation(attemptId, logicalName) !== expected) {
        sendJson(res, 409, {
          error: {
            category: 'artifact_upload',
            message: 'Artifact manifest changed',
            retryable: true,
          },
        });
        return true;
      }

      // No await between the lease recheck, publication and database write. If SQLite
      // fails, a later manifest reconciles the verified file or an idempotent PUT retries it.
      renameSync(partPath, destPath);
      storeArtifactRecord(options.db, attemptId, logicalName, destPath, expected);

      sendJson(res, 200, {
        ok: true,
        artifact_id: logicalName,
        sha256: calculatedSha256,
        size_bytes: sizeCounter,
      });
    } catch (error) {
      req.resume();
      if (error instanceof ArtifactStreamLimitError) {
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, 413, {
            error: {
              category: 'artifact_upload',
              message:
                sizeCounter > expected.size_bytes
                  ? `Artifact exceeded declared size_bytes (${expected.size_bytes}) from artifact_manifest`
                  : 'Artifact size limit exceeded',
              retryable: false,
            },
          });
        }
        return true;
      }
      logger.error('failed artifact upload write', {
        attemptId,
        artifactId: logicalName,
        error: String(error),
      });
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, {
          error: {
            category: 'artifact_upload',
            message: 'Failed to write artifact file',
            retryable: true,
          },
        });
      }
    } finally {
      release();
      if (partDir) {
        await rm(partDir, { recursive: true, force: true }).catch((error) => {
          logger.warn('failed to clean artifact upload staging', {
            attemptId,
            error: String(error),
          });
        });
      }
    }
    return true;
  }

  // Route 3: GET /data/v1/attempts/:attemptId/overlay
  const overlayMatch = /^\/data\/v1\/attempts\/([^/]+)\/overlay$/.exec(url.pathname);
  if (overlayMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: { category: 'validation', message: 'GET required', retryable: false },
      });
      return true;
    }
    const attemptId = overlayMatch[1];
    if (token.op !== 'overlay_download') {
      sendJson(res, 403, {
        error: {
          category: 'validation',
          message: 'Token claim mismatch for overlay download',
          retryable: false,
        },
      });
      return true;
    }

    const auth = authorizeSource(attemptId);
    if (!auth.ok) {
      sendAuthorizationFailure(res, auth);
      return true;
    }

    const row = options.db
      .prepare(
        `SELECT s.payload_path, s.size_bytes, s.sha256
         FROM job_attempts a
         JOIN jobs j ON a.job_id = j.id
         JOIN snapshots s ON j.snapshot_id = s.id
         WHERE a.id = ?`,
      )
      .get(attemptId) as { payload_path: string; size_bytes: number; sha256: string } | undefined;

    if (!row?.payload_path) {
      sendJson(res, 404, {
        error: {
          category: 'materialization',
          message: 'Overlay payload not found',
          retryable: false,
        },
      });
      return true;
    }

    await streamTransferFile(
      res,
      {
        path: row.payload_path,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        contentType: 'application/zstd',
      },
      () => authorizeSource(attemptId),
      trackTransfer,
      { attemptId, kind: 'overlay' },
    );
    return true;
  }

  // Route 4: GET /data/v1/attempts/:attemptId/bundle
  const bundleMatch = /^\/data\/v1\/attempts\/([^/]+)\/bundle$/.exec(url.pathname);
  if (bundleMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: { category: 'validation', message: 'GET required', retryable: false },
      });
      return true;
    }
    const attemptId = bundleMatch[1];
    if (token.op !== 'bundle_download') {
      sendJson(res, 403, {
        error: {
          category: 'validation',
          message: 'Token claim mismatch for bundle download',
          retryable: false,
        },
      });
      return true;
    }

    const auth = authorizeSource(attemptId);
    if (!auth.ok) {
      sendAuthorizationFailure(res, auth);
      return true;
    }

    const bundleDir = join(attemptTransferDir(options.dataDir, attemptId), 'bundle');
    let metadata: Awaited<ReturnType<typeof readBundleMetadata>>;
    try {
      metadata = await readBundleMetadata(bundleDir);
    } catch {
      if (!res.destroyed)
        sendJson(res, 404, {
          error: {
            category: 'materialization',
            message: 'Bundle payload not found',
            retryable: false,
          },
        });
      return true;
    }
    await streamTransferFile(
      res,
      {
        path: join(bundleDir, 'bundle.gitbundle'),
        ...metadata,
        contentType: 'application/octet-stream',
      },
      () => authorizeSource(attemptId),
      trackTransfer,
      { attemptId, kind: 'bundle' },
    );
    return true;
  }

  sendJson(res, 404, {
    error: { category: 'validation', message: 'Unknown data plane path', retryable: false },
  });
  return true;
}
