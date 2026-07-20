import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_CACHE_DIR_ENV_NAMES,
  BUILD_CACHE_KINDS,
  DEFAULT_BUILD_CACHE_CONFIG,
  buildCacheEnvForKind,
  computeBuildCacheKey,
  listPresentBuildCacheKeys,
  resolveBuildCacheInjection,
  resolveRelevantBuildCacheKinds,
  stripUserBuildCacheEnv,
} from '../src/build-cache/index.js';

function expectedKey(material: Record<string, string>, kind: string): string {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(material).sort()) {
    ordered[k] = material[k] as string;
  }
  const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  return `${kind}_${digest.slice(0, 32)}`;
}

describe('build cache kinds', () => {
  it('defines fixed kinds with documented env and subdirs', () => {
    expect(BUILD_CACHE_KINDS.map((d) => d.kind)).toEqual([
      'ccache',
      'sccache',
      'npm',
      'pnpm',
      'pip',
    ]);
    expect(BUILD_CACHE_KINDS.find((d) => d.kind === 'ccache')).toMatchObject({
      cacheDirEnv: 'CCACHE_DIR',
      relativeDir: 'ccache',
      requiresToolchain: true,
      extraEnv: { CCACHE_NOHASHDIR: '1' },
    });
    expect(BUILD_CACHE_KINDS.find((d) => d.kind === 'sccache')).toMatchObject({
      cacheDirEnv: 'SCCACHE_DIR',
      relativeDir: 'sccache',
      requiresToolchain: true,
    });
    expect(BUILD_CACHE_KINDS.find((d) => d.kind === 'npm')).toMatchObject({
      cacheDirEnv: 'npm_config_cache',
      relativeDir: 'npm',
      requiresToolchain: false,
    });
    expect(BUILD_CACHE_KINDS.find((d) => d.kind === 'pnpm')).toMatchObject({
      cacheDirEnv: 'PNPM_STORE_PATH',
      relativeDir: 'pnpm',
      requiresToolchain: false,
    });
    expect(BUILD_CACHE_KINDS.find((d) => d.kind === 'pip')).toMatchObject({
      cacheDirEnv: 'PIP_CACHE_DIR',
      relativeDir: 'pip',
      requiresToolchain: false,
    });
  });

  it('buildCacheEnvForKind only sets documented env vars under key root', () => {
    const env = buildCacheEnvForKind('npm', '/state/build-caches/npm_abc/npm');
    expect(env).toEqual({ npm_config_cache: '/state/build-caches/npm_abc/npm' });
    expect(Object.keys(env)).not.toContain('HOME');
  });
});

describe('computeBuildCacheKey', () => {
  it('returns kind_ + first 32 hex of sha256 of canonical JSON (no secrets)', () => {
    const input = {
      kind: 'npm' as const,
      toolchainProfileId: 'none',
      toolchainFingerprint: 'none',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:content_abc',
    };
    const key = computeBuildCacheKey(input);
    expect(key).toBe(
      expectedKey(
        {
          arch: 'x64',
          kind: 'npm',
          osFamily: 'linux',
          projectIdentity: 'local:content_abc',
          toolchainFingerprint: 'none',
          toolchainProfileId: 'none',
        },
        'npm',
      ),
    );
    expect(key.startsWith('npm_')).toBe(true);
    expect(key.length).toBe(4 + 32);
  });

  it('is stable across property insertion order', () => {
    const a = computeBuildCacheKey({
      kind: 'pip',
      arch: 'arm64',
      osFamily: 'macos',
      projectIdentity: 'repo_key_1',
      toolchainFingerprint: 'fp',
      toolchainProfileId: 'clang',
    });
    const b = computeBuildCacheKey({
      toolchainProfileId: 'clang',
      toolchainFingerprint: 'fp',
      projectIdentity: 'repo_key_1',
      osFamily: 'macos',
      arch: 'arm64',
      kind: 'pip',
    });
    expect(a).toBe(b);
  });
});

describe('resolveRelevantBuildCacheKinds', () => {
  it('intersects enabled kinds with job tools when tools are declared', () => {
    expect(
      resolveRelevantBuildCacheKinds({
        enabledKinds: ['ccache', 'sccache', 'npm', 'pnpm', 'pip'],
        requiredTools: { npm: '>=8', gcc: '14' },
      }),
    ).toEqual(['npm']);
  });

  it('uses all enabled kinds when no tools are declared', () => {
    expect(
      resolveRelevantBuildCacheKinds({
        enabledKinds: ['npm', 'pnpm'],
        requiredTools: undefined,
      }),
    ).toEqual(['npm', 'pnpm']);
  });
});

describe('resolveBuildCacheInjection', () => {
  it('injects package-manager kinds with none/none when no toolchain selected', () => {
    const result = resolveBuildCacheInjection({
      stateDir: '/agent-state',
      config: DEFAULT_BUILD_CACHE_CONFIG,
      preferBuildCache: true,
      riskLevel: 'normal',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:cid',
      selectedToolchain: null,
      requiredTools: { npm: '9', pip: '23' },
    });
    const npmKey = computeBuildCacheKey({
      kind: 'npm',
      toolchainProfileId: 'none',
      toolchainFingerprint: 'none',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:cid',
    });
    expect(result.env.npm_config_cache).toBe(join('/agent-state', 'build-caches', npmKey, 'npm'));
    expect(result.env.PIP_CACHE_DIR).toBeTruthy();
    expect(result.env.CCACHE_DIR).toBeUndefined();
    expect(result.env.SCCACHE_DIR).toBeUndefined();
  });

  it('skips ccache/sccache without selected toolchain (miss)', () => {
    const result = resolveBuildCacheInjection({
      stateDir: '/agent-state',
      config: DEFAULT_BUILD_CACHE_CONFIG,
      preferBuildCache: true,
      riskLevel: 'safe',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'repo_a',
      selectedToolchain: null,
      requiredTools: { ccache: '4', sccache: '0.8' },
    });
    expect(result.env).toEqual({});
    expect(result.injectedKinds).toEqual([]);
  });

  it('injects ccache when toolchain is selected', () => {
    const result = resolveBuildCacheInjection({
      stateDir: '/agent-state',
      config: DEFAULT_BUILD_CACHE_CONFIG,
      preferBuildCache: true,
      riskLevel: 'normal',
      osFamily: 'windows',
      arch: 'x64',
      projectIdentity: 'repo_a',
      selectedToolchain: { id: 'msvc-14', environment_fingerprint: 'fp1' },
      requiredTools: { ccache: '4' },
    });
    const key = computeBuildCacheKey({
      kind: 'ccache',
      toolchainProfileId: 'msvc-14',
      toolchainFingerprint: 'fp1',
      osFamily: 'windows',
      arch: 'x64',
      projectIdentity: 'repo_a',
    });
    expect(result.env.CCACHE_DIR).toBe(join('/agent-state', 'build-caches', key, 'ccache'));
    expect(result.env.CCACHE_NOHASHDIR).toBe('1');
    expect(result.injectedKinds).toEqual(['ccache']);
  });

  it('denies read+write injection for destructive/hardware by default', () => {
    for (const risk of ['destructive', 'hardware'] as const) {
      const result = resolveBuildCacheInjection({
        stateDir: '/agent-state',
        config: DEFAULT_BUILD_CACHE_CONFIG,
        preferBuildCache: true,
        riskLevel: risk,
        osFamily: 'linux',
        arch: 'x64',
        projectIdentity: 'local:x',
        selectedToolchain: null,
        requiredTools: { npm: '9' },
      });
      expect(result.env).toEqual({});
    }
  });

  it('returns empty when prefer_build_cache is false', () => {
    const result = resolveBuildCacheInjection({
      stateDir: '/agent-state',
      config: DEFAULT_BUILD_CACHE_CONFIG,
      preferBuildCache: false,
      riskLevel: 'normal',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:x',
      selectedToolchain: null,
      requiredTools: { npm: '9' },
    });
    expect(result.env).toEqual({});
  });

  it('never includes arbitrary host paths from caller beyond stateDir root', () => {
    const result = resolveBuildCacheInjection({
      stateDir: '/agent-state',
      config: DEFAULT_BUILD_CACHE_CONFIG,
      preferBuildCache: true,
      riskLevel: 'normal',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:x',
      selectedToolchain: null,
      requiredTools: { npm: '9' },
    });
    for (const value of Object.values(result.env)) {
      expect(value.startsWith(join('/agent-state', 'build-caches'))).toBe(true);
    }
  });
});

describe('stripUserBuildCacheEnv', () => {
  it('removes known cache env names so JobRequest cannot pass host paths', () => {
    const stripped = stripUserBuildCacheEnv({
      CCACHE_DIR: '/evil/ccache',
      npm_config_cache: '/evil/npm',
      PATH: '/usr/bin',
      FOO: 'bar',
    });
    expect(stripped.CCACHE_DIR).toBeUndefined();
    expect(stripped.npm_config_cache).toBeUndefined();
    expect(stripped.PATH).toBe('/usr/bin');
    expect(stripped.FOO).toBe('bar');
    for (const name of ALL_CACHE_DIR_ENV_NAMES) {
      expect(stripped[name]).toBeUndefined();
    }
  });
});

describe('listPresentBuildCacheKeys', () => {
  it('best-effort lists opaque keys under build-caches by kind prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-bc-'));
    const npmKey = 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ccKey = 'ccache_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await mkdir(join(root, 'build-caches', npmKey, 'npm'), { recursive: true });
    await mkdir(join(root, 'build-caches', ccKey, 'ccache'), { recursive: true });
    await writeFile(join(root, 'build-caches', npmKey, '.published'), '1\n');
    await writeFile(join(root, 'build-caches', ccKey, '.published'), '1\n');
    await writeFile(join(root, 'build-caches', 'not-a-key'), 'x');

    const listed = await listPresentBuildCacheKeys(root);
    expect(listed).toEqual(
      expect.arrayContaining([
        { kind: 'npm', keys: [npmKey] },
        { kind: 'ccache', keys: [ccKey] },
      ]),
    );
  });

  it('only advertises keys for enabled kinds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-bc-'));
    const npmKey = 'npm_cccccccccccccccccccccccccccccccc';
    const ccKey = 'ccache_dddddddddddddddddddddddddddddddd';
    await mkdir(join(root, 'build-caches', npmKey, 'npm'), { recursive: true });
    await mkdir(join(root, 'build-caches', ccKey, 'ccache'), { recursive: true });
    await writeFile(join(root, 'build-caches', npmKey, '.published'), '1\n');
    await writeFile(join(root, 'build-caches', ccKey, '.published'), '1\n');

    const listed = await listPresentBuildCacheKeys(root, ['npm']);
    expect(listed).toEqual([{ kind: 'npm', keys: [npmKey] }]);
  });
});
