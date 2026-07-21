import { afterEach, describe, expect, it } from 'vitest';
import { loadControllerConfig } from '../src/config.js';

const ENV_KEYS = ['RBO_ALLOWED_PROJECT_ROOTS', 'RBO_ALLOWED_ARTIFACT_DESTINATIONS'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('loadControllerConfig allowed roots/destinations (operator setup)', () => {
  it('defaults to empty (no jobs allowed) when unset — matches documented safe-by-default', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const config = loadControllerConfig();
    expect(config.allowedProjectRoots).toEqual([]);
    expect(config.allowedArtifactDestinations).toEqual([]);
  });

  it('parses RBO_ALLOWED_PROJECT_ROOTS / RBO_ALLOWED_ARTIFACT_DESTINATIONS as comma-separated lists', () => {
    process.env.RBO_ALLOWED_PROJECT_ROOTS = 'C:/repos/one, C:/repos/two';
    process.env.RBO_ALLOWED_ARTIFACT_DESTINATIONS = 'C:/out';
    const config = loadControllerConfig();
    expect(config.allowedProjectRoots).toEqual(['C:/repos/one', 'C:/repos/two']);
    expect(config.allowedArtifactDestinations).toEqual(['C:/out']);
  });

  it('an explicit override still wins over the environment variable', () => {
    process.env.RBO_ALLOWED_PROJECT_ROOTS = 'C:/should-not-be-used';
    const config = loadControllerConfig({ allowedProjectRoots: ['C:/explicit'] });
    expect(config.allowedProjectRoots).toEqual(['C:/explicit']);
  });
});
