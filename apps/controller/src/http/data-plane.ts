import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { ControllerIdentity } from '@rbo/shared';
import { createLogger, generateId, isPathContained, isSafeRelativePath } from '@rbo/shared';
import { attemptArtifactsDir, attemptTransferDir } from '../execution/runner.js';
import { verifyDataToken } from '../security/data-tokens.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';

const logger = createLogger('controller.data-plane');

export interface DataPlaneOptions {
  db: ControllerDatabase;
  identity: ControllerIdentity;
  dataDir: string;
}

interface ArtifactExpectation {
  size_bytes: number;
  sha256: string;
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
    artifactExpectations.set(expectationKey(attemptId, art.logical_name), {
      size_bytes: art.size_bytes,
      sha256: art.sha256,
    });
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

export async function handleDataPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DataPlaneOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
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

    const auth = authorizeAttemptToken(options.db, token, attemptId, [
      'preparing_source',
      'transferring_source',
      'materializing',
    ]);
    if (!auth.ok) {
      sendJson(res, auth.status, {
        error: { category: 'validation', message: auth.message, retryable: false },
      });
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

    const transferSnapshot = join(
      attemptTransferDir(options.dataDir, attemptId),
      'snapshot.tar.zst',
    );
    let payloadPath = row?.payload_path;
    let sizeBytes = row?.size_bytes;
    let sha256 = row?.sha256;
    try {
      await access(transferSnapshot);
      const transferStats = await stat(transferSnapshot);
      payloadPath = transferSnapshot;
      sizeBytes = transferStats.size;
      // Header must match the bytes we stream (fallback archive ≠ DB overlay hash).
      const transferData = await readFile(transferSnapshot);
      sha256 = createHash('sha256').update(transferData).digest('hex');
    } catch {
      // use DB snapshot path
    }

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

    try {
      const fileStats = await stat(payloadPath);
      res.writeHead(200, {
        'content-type': 'application/zstd',
        'content-length': fileStats.size,
        'x-rbo-sha256': sha256,
      });
      const stream = createReadStream(payloadPath);
      stream.pipe(res);
    } catch (error) {
      logger.error('failed to stream snapshot', { attemptId, error: String(error) });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            category: 'internal',
            message: 'Failed to read snapshot file',
            retryable: false,
          },
        });
      }
    }
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
    const artifactIdRaw = artifactMatch[2];
    const logicalName = decodeURIComponent(artifactIdRaw);

    if (token.op !== 'artifact_upload' || (token.artifactId && token.artifactId !== logicalName)) {
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

    const auth = authorizeAttemptToken(options.db, token, attemptId, ['collecting_artifacts']);
    if (!auth.ok) {
      sendJson(res, auth.status, {
        error: { category: 'validation', message: auth.message, retryable: false },
      });
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

    const artifactsDir = attemptArtifactsDir(options.dataDir, attemptId);
    const destPath = join(artifactsDir, logicalName);
    if (!isPathContained(artifactsDir, destPath)) {
      sendJson(res, 400, {
        error: {
          category: 'artifact_upload',
          message: 'Artifact path escapes attempt artifact directory',
          retryable: false,
        },
      });
      return true;
    }
    const partPath = join(
      artifactsDir,
      `.upload-${createHash('sha256').update(logicalName).digest('hex').slice(0, 16)}.part`,
    );

    await mkdir(dirname(destPath), { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    const hasher = createHash('sha256');
    const writeStream = createWriteStream(partPath);
    let sizeCounter = 0;
    let limitExceeded = false;
    const streamLimitBytes = artifactUploadStreamLimit(expected.size_bytes);

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          fn();
        };

        writeStream.on('finish', () => settle(resolvePromise));
        writeStream.on('close', () => settle(resolvePromise));
        writeStream.on('error', (err) => settle(() => rejectPromise(err)));

        req.on('data', (chunk: Buffer) => {
          if (limitExceeded) {
            return;
          }
          sizeCounter += chunk.length;
          if (sizeCounter > streamLimitBytes) {
            limitExceeded = true;
            req.unpipe(writeStream);
            writeStream.destroy();
            req.resume();
            void rm(partPath, { force: true });
            if (!res.headersSent) {
              const overManifest = sizeCounter > expected.size_bytes;
              sendJson(res, 413, {
                error: {
                  category: 'artifact_upload',
                  message: overManifest
                    ? `Artifact exceeded declared size_bytes (${expected.size_bytes}) from artifact_manifest`
                    : 'Artifact size limit exceeded',
                  retryable: false,
                },
              });
            }
            // destroy() may not emit finish/error; close settles the write Promise.
            settle(resolvePromise);
            return;
          }
          hasher.update(chunk);
        });

        req.pipe(writeStream);
      });

      if (limitExceeded || res.headersSent) {
        return true;
      }

      const calculatedSha256 = hasher.digest('hex');

      if (sizeCounter !== expected.size_bytes) {
        await rm(partPath, { force: true });
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
        await rm(partPath, { force: true });
        sendJson(res, 400, {
          error: {
            category: 'snapshot_hash',
            message: 'Artifact SHA-256 mismatch vs artifact_manifest',
            retryable: false,
          },
        });
        return true;
      }

      // Drop expectation after successful verification so re-uploads require a new manifest.
      artifactExpectations.delete(expectationKey(attemptId, logicalName));

      await rename(partPath, destPath);

      const attemptRow = options.db
        .prepare('SELECT job_id FROM job_attempts WHERE id = ?')
        .get(attemptId) as { job_id: string } | undefined;
      if (attemptRow) {
        const id = generateId('art');
        options.db
          .prepare(
            `INSERT INTO artifacts (id, job_id, attempt_id, logical_name, path, size_bytes, sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(attempt_id, logical_name) DO UPDATE SET
               size_bytes = excluded.size_bytes,
               sha256 = excluded.sha256,
               path = excluded.path`,
          )
          .run(
            id,
            attemptRow.job_id,
            attemptId,
            logicalName,
            destPath,
            sizeCounter,
            calculatedSha256,
            nowIso(),
          );
      }

      sendJson(res, 200, {
        ok: true,
        artifact_id: logicalName,
        sha256: calculatedSha256,
        size_bytes: sizeCounter,
      });
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      logger.error('failed artifact upload write', {
        attemptId,
        artifactId: logicalName,
        error: String(error),
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            category: 'artifact_upload',
            message: 'Failed to write artifact file',
            retryable: false,
          },
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

    const auth = authorizeAttemptToken(options.db, token, attemptId, [
      'preparing_source',
      'transferring_source',
      'materializing',
    ]);
    if (!auth.ok) {
      sendJson(res, auth.status, {
        error: { category: 'validation', message: auth.message, retryable: false },
      });
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

    try {
      const fileStats = await stat(row.payload_path);
      res.writeHead(200, {
        'content-type': 'application/zstd',
        'content-length': fileStats.size,
        'x-rbo-sha256': row.sha256,
      });
      createReadStream(row.payload_path).pipe(res);
    } catch (error) {
      logger.error('failed to stream overlay', { attemptId, error: String(error) });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            category: 'internal',
            message: 'Failed to read overlay file',
            retryable: false,
          },
        });
      }
    }
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

    const auth = authorizeAttemptToken(options.db, token, attemptId, [
      'preparing_source',
      'transferring_source',
      'materializing',
    ]);
    if (!auth.ok) {
      sendJson(res, auth.status, {
        error: { category: 'validation', message: auth.message, retryable: false },
      });
      return true;
    }

    const bundlePath = join(attemptTransferDir(options.dataDir, attemptId), 'bundle.gitbundle');
    try {
      const data = await readFile(bundlePath);
      const sha256 = createHash('sha256').update(data).digest('hex');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'x-rbo-sha256': sha256,
      });
      res.end(data);
    } catch {
      sendJson(res, 404, {
        error: {
          category: 'materialization',
          message: 'Bundle payload not found',
          retryable: false,
        },
      });
    }
    return true;
  }

  sendJson(res, 404, {
    error: { category: 'validation', message: 'Unknown data plane path', retryable: false },
  });
  return true;
}
