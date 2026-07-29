import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadAgentConfig,
  resolveRepoCacheRoot,
  resolveReposDir,
  writeDefaultAgentConfigFile,
} from '../src/config.js';

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-agent-cfg-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseOverrides() {
  return {
    controllerUrl: 'wss://controller.example:7411/agent',
    controllerFingerprint: `sha256:${'a'.repeat(64)}`,
    stateDir: '/var/lib/rbo-agent',
    configPath: null as null,
  };
}

describe('agent repo cache directory (§2.8)', () => {
  it('defaults mirror cache to a sibling disposable dir outside stateDir', () => {
    const config = loadAgentConfig(baseOverrides());
    expect(resolveRepoCacheRoot(config)).toBe(join('/var/lib', 'repo-cache'));
    expect(resolveReposDir(config)).toBe(join('/var/lib', 'repo-cache', 'repos'));
    expect(resolveReposDir(config)).not.toBe(join(config.stateDir, 'repos'));
  });

  it('honors RBO_REPO_CACHE_DIR override', () => {
    const cacheDir = '/mnt/fast/repo-cache';
    setEnv('RBO_REPO_CACHE_DIR', cacheDir);
    const config = loadAgentConfig(baseOverrides());
    expect(resolveRepoCacheRoot(config)).toBe(cacheDir);
    expect(resolveReposDir(config)).toBe(join(cacheDir, 'repos'));
  });

  it('prefers explicit repoCacheDir override over env', () => {
    setEnv('RBO_REPO_CACHE_DIR', '/mnt/env/repo-cache');
    const config = loadAgentConfig({
      ...baseOverrides(),
      repoCacheDir: '/mnt/explicit/repo-cache',
    });
    expect(resolveRepoCacheRoot(config)).toBe('/mnt/explicit/repo-cache');
  });

  it('keeps identity stateDir separate from mirror cache root', () => {
    const stateDir = join('/data', 'rbo-agent');
    const config = loadAgentConfig({ ...baseOverrides(), stateDir });
    expect(dirname(resolveRepoCacheRoot(config))).toBe(dirname(stateDir));
    expect(resolveRepoCacheRoot(config)).not.toBe(stateDir);
  });

  it('places repo cache beside unified default agent state under RBO_DATA_DIR', () => {
    setEnv('RBO_DATA_DIR', '/data/rbo');
    setEnv('RBO_AGENT_STATE_DIR', undefined);
    const config = loadAgentConfig({
      controllerUrl: 'wss://controller.example:7411/agent',
      controllerFingerprint: `sha256:${'a'.repeat(64)}`,
      configPath: null,
    });
    expect(config.stateDir).toBe(join('/data/rbo', 'agent'));
    expect(resolveRepoCacheRoot(config)).toBe(join('/data/rbo', 'repo-cache'));
  });
});

describe('agent.json file load + precedence', () => {
  it('writeDefaultAgentConfigFile writes complete defaults once', () => {
    const stateDir = tempDir();
    const first = writeDefaultAgentConfigFile(stateDir);
    expect(first.written).toBe(true);
    expect(first.schema_version).toBe(1);
    const second = writeDefaultAgentConfigFile(stateDir);
    expect(second.written).toBe(false);
    expect(second.initialized_at).toBe(first.initialized_at);
  });

  it('loads controller_url / fingerprint from agent.json when env is unset', () => {
    setEnv('RBO_CONTROLLER_URL', undefined);
    setEnv('RBO_CONTROLLER_FINGERPRINT', undefined);
    setEnv('RBO_AGENT_NAME', undefined);
    const stateDir = tempDir();
    writeDefaultAgentConfigFile(stateDir);
    writeFileSync(
      join(stateDir, 'agent.json'),
      JSON.stringify({
        controller_url: 'wss://file.example:7411/agent',
        controller_fingerprint: `sha256:${'b'.repeat(64)}`,
        display_name: 'from-file',
        max_jobs: 3,
      }),
      'utf8',
    );
    const config = loadAgentConfig({ stateDir });
    expect(config.controllerUrl).toBe('wss://file.example:7411/agent');
    expect(config.controllerFingerprint).toBe(`sha256:${'b'.repeat(64)}`);
    expect(config.displayName).toBe('from-file');
    expect(config.maxJobs).toBe(3);
  });

  it('env overrides agent.json; programmatic overrides win over env', () => {
    const stateDir = tempDir();
    writeDefaultAgentConfigFile(stateDir);
    writeFileSync(
      join(stateDir, 'agent.json'),
      JSON.stringify({
        controller_url: 'wss://file.example:7411/agent',
        controller_fingerprint: `sha256:${'b'.repeat(64)}`,
        display_name: 'from-file',
      }),
      'utf8',
    );
    setEnv('RBO_CONTROLLER_URL', 'wss://env.example:7411/agent');
    setEnv('RBO_CONTROLLER_FINGERPRINT', `sha256:${'c'.repeat(64)}`);
    setEnv('RBO_AGENT_NAME', 'from-env');
    const fromEnv = loadAgentConfig({ stateDir });
    expect(fromEnv.controllerUrl).toBe('wss://env.example:7411/agent');
    expect(fromEnv.displayName).toBe('from-env');

    const fromOverride = loadAgentConfig({
      stateDir,
      controllerUrl: 'wss://override.example:7411/agent',
      controllerFingerprint: `sha256:${'d'.repeat(64)}`,
      displayName: 'from-override',
    });
    expect(fromOverride.controllerUrl).toBe('wss://override.example:7411/agent');
    expect(fromOverride.displayName).toBe('from-override');
  });

  it('rejects empty controller_url with a file-oriented error', () => {
    setEnv('RBO_CONTROLLER_URL', undefined);
    setEnv('RBO_CONTROLLER_FINGERPRINT', undefined);
    const stateDir = tempDir();
    writeDefaultAgentConfigFile(stateDir);
    expect(() => loadAgentConfig({ stateDir })).toThrow(/agent\.json/);
  });

  it('skips corrupt agent.json without --force instead of throwing', () => {
    const stateDir = tempDir();
    writeFileSync(join(stateDir, 'agent.json'), '{not-json', 'utf8');
    const result = writeDefaultAgentConfigFile(stateDir);
    expect(result.written).toBe(false);
    expect(result.path).toBe(join(stateDir, 'agent.json'));
  });

  it('throws a clear error for invalid numeric env values', () => {
    setEnv('RBO_MAX_JOBS', 'nope');
    expect(() => loadAgentConfig(baseOverrides())).toThrow(/RBO_MAX_JOBS/);
  });
});
