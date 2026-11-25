import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAttemptLogs } from '../src/logs.js';
import { CANONICAL_RBO_ENV_KEYS, buildReservedRboEnv } from '../src/runtime-env.js';
import { runCleanupScript, spawnJobScript, writeJobScript } from '../src/script.js';

describe('canonical RBO runtime env', () => {
  it('exports required keys including RBO_ARTIFACT_DIR (not plural)', () => {
    expect(CANONICAL_RBO_ENV_KEYS).toContain('RBO_JOB_ID');
    expect(CANONICAL_RBO_ENV_KEYS).toContain('RBO_ATTEMPT_ID');
    expect(CANONICAL_RBO_ENV_KEYS).toContain('RBO_LOG_DIR');
    expect(CANONICAL_RBO_ENV_KEYS).toContain('RBO_ARTIFACT_DIR');
    expect(CANONICAL_RBO_ENV_KEYS).not.toContain('RBO_ARTIFACTS_DIR');
  });

  it('reserved values win over user RBO_* keys', () => {
    const reserved = buildReservedRboEnv({
      jobId: 'job_1',
      attemptId: 'att_1',
      workspacePath: '/ws',
      projectPath: '/ws/project',
      logDir: '/logs',
      artifactDir: '/arts',
      extra: {
        RBO_JOB_ID: 'user',
        RBO_ARTIFACT_DIR: '/user-singular',
        RBO_ARTIFACTS_DIR: '/user-plural',
        RBO_LOG_DIR: '/user-logs',
        NOT_RBO: 'keep',
      },
    });
    expect(reserved.RBO_ARTIFACT_DIR).toBe('/arts');
    expect(reserved.RBO_JOB_ID).toBe('job_1');
    expect(reserved.RBO_LOG_DIR).toBe('/logs');
    expect(reserved.NOT_RBO).toBe('keep');
    expect(reserved).not.toHaveProperty('RBO_ARTIFACTS_DIR');
    expect(
      Object.keys(reserved)
        .filter((key) => key.startsWith('RBO_'))
        .sort(),
    ).toEqual([...CANONICAL_RBO_ENV_KEYS].sort());
  });

  it('spawnJobScript ignores plural RBO_ARTIFACTS_DIR in execution.env (no alias)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-runtime-env-'));
    const controlDir = join(workspace, 'control');
    const logs = await ensureAttemptLogs(join(workspace, 'logs'));
    const artifactDir = join(workspace, 'artifacts');
    try {
      const isWin = process.platform === 'win32';
      const script = isWin
        ? `Get-ChildItem Env:RBO_ARTIFACT* | ForEach-Object { "$($_.Name)=$($_.Value)" }`
        : `#!/bin/bash\nenv | grep '^RBO_ARTIFACT' | sort`;
      await writeJobScript(controlDir, {
        shell: isWin ? 'powershell' : 'bash',
        script,
        timeout_seconds: 30,
        cancel_grace_seconds: 1,
      });
      const child = spawnJobScript({
        attemptId: 'att_env',
        controlDir,
        workspacePath: workspace,
        projectPath: workspace,
        execution: {
          shell: isWin ? 'powershell' : 'bash',
          script,
          timeout_seconds: 30,
          cancel_grace_seconds: 1,
          env: {
            RBO_ARTIFACTS_DIR: '/user/wrong-artifacts',
            RBO_JOB_ID: 'user-job',
          },
        },
        env: buildReservedRboEnv({
          jobId: 'job_reserved',
          attemptId: 'att_env',
          workspacePath: workspace,
          projectPath: workspace,
          logDir: logs.logDir,
          artifactDir,
        }),
        logs,
      });
      expect(child.ignoredRboEnvKeys).toContain('RBO_ARTIFACTS_DIR');
      expect(child.ignoredRboEnvKeys).toContain('RBO_JOB_ID');
      await child.waitForExit();
      const stdout = await readFile(logs.stdoutPath, 'utf8');
      expect(stdout).not.toMatch(/RBO_ARTIFACTS_DIR/);
      const artifactLines = stdout.split(/\r?\n/).filter((line) => line.includes('RBO_ARTIFACT'));
      expect(artifactLines).toHaveLength(1);
      expect(artifactLines[0]).toBe(`RBO_ARTIFACT_DIR=${artifactDir}`);
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 30_000);

  it('does not pass inherited service bearer tokens to job or cleanup scripts', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-service-token-env-'));
    const controlDir = join(workspace, 'control');
    const logs = await ensureAttemptLogs(join(workspace, 'logs'));
    const protectedNames = new Set(['RBO_ADMIN_TOKEN', 'RBO_MCP_TOKEN']);
    const originalEntries = Object.entries(process.env).filter(([key]) =>
      protectedNames.has(key.toUpperCase()),
    );
    const isWin = process.platform === 'win32';
    const script = isWin
      ? '@if defined RBO_ADMIN_TOKEN exit /b 7\r\n@if defined RBO_MCP_TOKEN exit /b 7\r\n@exit /b 0'
      : 'test -z "${RBO_ADMIN_TOKEN+x}${RBO_MCP_TOKEN+x}${rbo_mcp_token+x}"';

    try {
      for (const key of Object.keys(process.env)) {
        if (protectedNames.has(key.toUpperCase())) {
          delete process.env[key];
        }
      }
      process.env.RBO_ADMIN_TOKEN = 'dummy-admin-token';
      process.env.rbo_mcp_token = 'dummy-mcp-token';

      const execution = {
        shell: isWin ? ('cmd' as const) : ('bash' as const),
        script,
        cleanup_script: script,
        timeout_seconds: 30,
        cancel_grace_seconds: 1,
        env: {
          RBO_ADMIN_TOKEN: 'job-admin-override',
          RBO_MCP_TOKEN: 'job-mcp-override',
        },
      };
      await writeJobScript(controlDir, execution);
      const child = spawnJobScript({
        attemptId: 'att_service_tokens',
        controlDir,
        workspacePath: workspace,
        projectPath: workspace,
        execution,
        env: buildReservedRboEnv({
          jobId: 'job_service_tokens',
          attemptId: 'att_service_tokens',
          workspacePath: workspace,
          projectPath: workspace,
          logDir: logs.logDir,
          artifactDir: join(workspace, 'artifacts'),
        }),
        logs,
      });
      expect(child.ignoredRboEnvKeys).toEqual(['RBO_ADMIN_TOKEN', 'RBO_MCP_TOKEN']);
      expect((await child.waitForExit()).exitCode).toBe(0);

      const cleanup = await runCleanupScript({
        attemptId: 'att_service_tokens',
        controlDir,
        workspacePath: workspace,
        projectPath: workspace,
        execution,
        env: buildReservedRboEnv({
          jobId: 'job_service_tokens',
          attemptId: 'att_service_tokens',
          workspacePath: workspace,
          projectPath: workspace,
          logDir: logs.logDir,
          artifactDir: join(workspace, 'artifacts'),
        }),
        logs,
      });
      expect(cleanup).toEqual({ exitCode: 0, timedOut: false });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (protectedNames.has(key.toUpperCase())) {
          delete process.env[key];
        }
      }
      for (const [key, value] of originalEntries) {
        process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 30_000);
});
