import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadControllerConfig,
  readControllerConfigFile,
  writeDefaultControllerConfigFile,
} from '../src/config.js';

const ENV_KEYS = [
  'RBO_ALLOWED_PROJECT_ROOTS',
  'RBO_ALLOWED_ARTIFACT_DESTINATIONS',
  'RBO_MCP_PORT',
  'RBO_ALLOW_LOCAL_FALLBACK',
  'RBO_ALLOW_FULL_SNAPSHOT_FALLBACK',
  'RBO_DEFAULT_QUEUE_POLICY',
  'RBO_MAX_SNAPSHOT_SOURCE_BYTES',
  'RBO_MAX_SNAPSHOT_FILE_COUNT',
  'RBO_MAX_SNAPSHOT_SINGLE_FILE_BYTES',
  'RBO_MAX_SNAPSHOT_TEMPORARY_BYTES',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-ctrl-cfg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('allow_full_snapshot_fallback (§10.4)', () => {
  it('defaults to false so a full working-tree upload is never silent', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(loadControllerConfig({ configPath: null }).allowFullSnapshotFallback).toBe(false);
  });

  it('honours the config file, and env overrides it', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(path, JSON.stringify({ allow_full_snapshot_fallback: true }), 'utf8');
    expect(loadControllerConfig({ dataDir }).allowFullSnapshotFallback).toBe(true);

    process.env.RBO_ALLOW_FULL_SNAPSHOT_FALLBACK = 'false';
    expect(loadControllerConfig({ dataDir }).allowFullSnapshotFallback).toBe(false);
  });
});

describe('default_queue_policy (queue when no Agent has capacity)', () => {
  it('defaults to "wait" so jobs queue for an eligible Agent instead of falling back locally', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(loadControllerConfig({ configPath: null }).defaultQueuePolicy).toBe('wait');
  });

  it('honours the config file, and env overrides it', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(path, JSON.stringify({ default_queue_policy: 'fail_fast' }), 'utf8');
    expect(loadControllerConfig({ dataDir }).defaultQueuePolicy).toBe('fail_fast');

    process.env.RBO_DEFAULT_QUEUE_POLICY = 'local_fallback';
    expect(loadControllerConfig({ dataDir }).defaultQueuePolicy).toBe('local_fallback');
  });

  it('rejects an unknown policy value from the file', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(path, JSON.stringify({ default_queue_policy: 'bogus' }), 'utf8');
    expect(() => readControllerConfigFile(path)).toThrow();
  });

  it('an explicit programmatic override still wins over the environment variable', () => {
    process.env.RBO_DEFAULT_QUEUE_POLICY = 'local_fallback';
    expect(
      loadControllerConfig({ configPath: null, defaultQueuePolicy: 'wait' }).defaultQueuePolicy,
    ).toBe('wait');
  });
});

describe('snapshot capture limits (§4.3)', () => {
  it('uses conservative defaults and lets file/env/programmatic values override them', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const defaults = loadControllerConfig({ configPath: null }).snapshotCaptureLimits;
    expect(defaults).toEqual({
      maxTotalSourceBytes: 1024 * 1024 * 1024,
      maxRegularFileCount: 100_000,
      maxSingleFileBytes: 256 * 1024 * 1024,
      maxTemporarySnapshotBytes: 1280 * 1024 * 1024,
    });

    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(
      path,
      JSON.stringify({
        max_snapshot_source_bytes: 1000,
        max_snapshot_file_count: 20,
        max_snapshot_single_file_bytes: 500,
        max_snapshot_temporary_bytes: 1200,
      }),
      'utf8',
    );
    expect(loadControllerConfig({ dataDir }).snapshotCaptureLimits).toEqual({
      maxTotalSourceBytes: 1000,
      maxRegularFileCount: 20,
      maxSingleFileBytes: 500,
      maxTemporarySnapshotBytes: 1200,
    });

    process.env.RBO_MAX_SNAPSHOT_SINGLE_FILE_BYTES = '600';
    expect(loadControllerConfig({ dataDir }).snapshotCaptureLimits.maxSingleFileBytes).toBe(600);
    expect(
      loadControllerConfig({
        dataDir,
        snapshotCaptureLimits: {
          maxTotalSourceBytes: 2000,
          maxRegularFileCount: 30,
          maxSingleFileBytes: 700,
          maxTemporarySnapshotBytes: 2200,
        },
      }).snapshotCaptureLimits,
    ).toEqual({
      maxTotalSourceBytes: 2000,
      maxRegularFileCount: 30,
      maxSingleFileBytes: 700,
      maxTemporarySnapshotBytes: 2200,
    });
  });

  it('rejects non-positive snapshot limit values from controller.json and the environment', () => {
    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(path, JSON.stringify({ max_snapshot_source_bytes: 0 }), 'utf8');
    expect(() => readControllerConfigFile(path)).toThrow();

    process.env.RBO_MAX_SNAPSHOT_FILE_COUNT = '0';
    expect(() => loadControllerConfig({ configPath: null })).toThrow(/RBO_MAX_SNAPSHOT_FILE_COUNT/);
  });
});

describe('loadControllerConfig allowed roots/destinations (operator setup)', () => {
  it('defaults to empty (no jobs allowed) when unset — matches documented safe-by-default', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const config = loadControllerConfig({ configPath: null });
    expect(config.allowedProjectRoots).toEqual([]);
    expect(config.allowedArtifactDestinations).toEqual([]);
  });

  it('parses RBO_ALLOWED_PROJECT_ROOTS / RBO_ALLOWED_ARTIFACT_DESTINATIONS as comma-separated lists', () => {
    process.env.RBO_ALLOWED_PROJECT_ROOTS = 'C:/repos/one, C:/repos/two';
    process.env.RBO_ALLOWED_ARTIFACT_DESTINATIONS = 'C:/out';
    const config = loadControllerConfig({ configPath: null });
    expect(config.allowedProjectRoots).toEqual(['C:/repos/one', 'C:/repos/two']);
    expect(config.allowedArtifactDestinations).toEqual(['C:/out']);
  });

  it('an explicit override still wins over the environment variable', () => {
    process.env.RBO_ALLOWED_PROJECT_ROOTS = 'C:/should-not-be-used';
    const config = loadControllerConfig({
      configPath: null,
      allowedProjectRoots: ['C:/explicit'],
    });
    expect(config.allowedProjectRoots).toEqual(['C:/explicit']);
  });

  it('rejects empty, dot, and relative allowlist paths from file', () => {
    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    for (const bad of ['', '.', 'relative/path', '  ']) {
      writeFileSync(path, JSON.stringify({ allowed_project_roots: [bad] }), 'utf8');
      expect(() => readControllerConfigFile(path)).toThrow(/absolute path/i);
    }
  });

  it('rejects relative allowlist paths from env', () => {
    process.env.RBO_ALLOWED_PROJECT_ROOTS = 'relative/path';
    expect(() => loadControllerConfig({ configPath: null })).toThrow(/absolute path/i);
  });
});

describe('controller.json file load + precedence', () => {
  it('writeDefaultControllerConfigFile writes once and skips overwrite without force', () => {
    const dataDir = tempDir();
    const first = writeDefaultControllerConfigFile(dataDir);
    expect(first.written).toBe(true);
    writeFileSync(first.path, '{"mcp_port":9999,"allowed_project_roots":["C:/kept"]}\n', 'utf8');
    const second = writeDefaultControllerConfigFile(dataDir);
    expect(second.written).toBe(false);
    const config = loadControllerConfig({ dataDir, configPath: first.path });
    expect(config.mcpPort).toBe(9999);
    expect(config.allowedProjectRoots).toEqual(['C:/kept']);
  });

  it('loads values from controller.json when env is unset', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const dataDir = tempDir();
    const { path } = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(
      path,
      JSON.stringify({
        mcp_port: 7500,
        allowed_project_roots: ['C:/from-file'],
        allow_local_fallback: false,
      }),
      'utf8',
    );
    const config = loadControllerConfig({ dataDir });
    expect(config.mcpPort).toBe(7500);
    expect(config.allowedProjectRoots).toEqual(['C:/from-file']);
    expect(config.allowLocalFallback).toBe(false);
  });

  it('env overrides controller.json; programmatic overrides win over env', () => {
    const dataDir = tempDir();
    writeDefaultControllerConfigFile(dataDir);
    writeFileSync(
      join(dataDir, 'controller.json'),
      JSON.stringify({ mcp_port: 7500, allowed_project_roots: ['C:/from-file'] }),
      'utf8',
    );
    process.env.RBO_MCP_PORT = '7600';
    process.env.RBO_ALLOWED_PROJECT_ROOTS = 'C:/from-env';
    const fromEnv = loadControllerConfig({ dataDir });
    expect(fromEnv.mcpPort).toBe(7600);
    expect(fromEnv.allowedProjectRoots).toEqual(['C:/from-env']);

    const fromOverride = loadControllerConfig({
      dataDir,
      mcpPort: 7700,
      allowedProjectRoots: ['C:/from-override'],
    });
    expect(fromOverride.mcpPort).toBe(7700);
    expect(fromOverride.allowedProjectRoots).toEqual(['C:/from-override']);
  });

  it('force rewrites controller.json defaults', () => {
    const dataDir = tempDir();
    const first = writeDefaultControllerConfigFile(dataDir);
    writeFileSync(first.path, '{"mcp_port":1}\n', 'utf8');
    const second = writeDefaultControllerConfigFile(dataDir, { force: true });
    expect(second.written).toBe(true);
    const config = loadControllerConfig({ dataDir });
    expect(config.mcpPort).toBe(7410);
    expect(config.allowedProjectRoots).toEqual([]);
  });

  it('throws a clear error for invalid numeric env values', () => {
    process.env.RBO_MCP_PORT = 'abc';
    expect(() => loadControllerConfig({ configPath: null })).toThrow(/RBO_MCP_PORT/);
  });
});
