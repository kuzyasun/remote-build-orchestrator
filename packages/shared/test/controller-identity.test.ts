import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureControllerIdentity, readAdminToken } from '../src/controller-identity.js';

describe('Controller identity and admin token handling', () => {
  let tempDir: string;
  let priorEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rbo-identity-test-'));
    priorEnv = process.env.RBO_ADMIN_TOKEN;
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to string
    delete process.env.RBO_ADMIN_TOKEN;
  });

  afterEach(() => {
    if (priorEnv !== undefined) {
      process.env.RBO_ADMIN_TOKEN = priorEnv;
    } else {
      // biome-ignore lint/performance/noDelete: process.env coerces undefined to string
      delete process.env.RBO_ADMIN_TOKEN;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates a 64-char hex admin token with 0600 mode on first initialization', async () => {
    const identity = await ensureControllerIdentity(tempDir);
    expect(identity.adminToken).toMatch(/^[0-9a-f]{64}$/);

    const tokenPath = join(tempDir, 'security', 'admin-token');
    const diskContent = readFileSync(tokenPath, 'utf8').trim();
    expect(diskContent).toBe(identity.adminToken);

    if (process.platform !== 'win32') {
      const mode = statSync(tokenPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('reads admin token from layout dataDir when RBO_ADMIN_TOKEN is unset', async () => {
    const identity = await ensureControllerIdentity(tempDir);
    const token = readAdminToken({ env: { RBO_DATA_DIR: tempDir } });
    expect(token).toBe(identity.adminToken);
  });

  it('prefers options.env.RBO_ADMIN_TOKEN over disk token in readAdminToken', async () => {
    await ensureControllerIdentity(tempDir);
    const token = readAdminToken({
      env: {
        RBO_DATA_DIR: tempDir,
        RBO_ADMIN_TOKEN: 'custom-secret-from-env',
      },
    });
    expect(token).toBe('custom-secret-from-env');
  });

  it('respects process.env.RBO_ADMIN_TOKEN in ensureControllerIdentity', async () => {
    process.env.RBO_ADMIN_TOKEN = 'env-override-token';
    const identity = await ensureControllerIdentity(tempDir);
    expect(identity.adminToken).toBe('env-override-token');

    // Also verify readAdminToken matches
    const token = readAdminToken({ env: { ...process.env, RBO_DATA_DIR: tempDir } });
    expect(token).toBe('env-override-token');
  });
});
