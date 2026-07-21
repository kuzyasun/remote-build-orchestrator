import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, resolveRepoCacheRoot, resolveReposDir } from '../src/config.js';

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
});

function baseOverrides() {
  return {
    controllerUrl: 'wss://controller.example:7411/agent',
    controllerFingerprint: `sha256:${'a'.repeat(64)}`,
    stateDir: '/var/lib/rbo-agent',
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
});
