import { describe, expect, it } from 'vitest';
import {
  AgentCapabilityReportSchema,
  BuildCacheKindSchema,
  PreferencesConfigSchema,
} from '../src/schemas.js';

describe('Phase 7 Protocol Schemas — build caches', () => {
  it('exports BuildCacheKindSchema with fixed kinds only', () => {
    expect(BuildCacheKindSchema.options).toEqual(['ccache', 'sccache', 'npm', 'pnpm', 'pip']);
    expect(BuildCacheKindSchema.safeParse('ccache').success).toBe(true);
    expect(BuildCacheKindSchema.safeParse('cargo').success).toBe(false);
    expect(BuildCacheKindSchema.safeParse('/host/cache').success).toBe(false);
  });

  it('defaults prefer_build_cache to true on PreferencesConfigSchema', () => {
    const parsed = PreferencesConfigSchema.parse({});
    expect(parsed.prefer_build_cache).toBe(true);
    expect(PreferencesConfigSchema.parse({ prefer_build_cache: false }).prefer_build_cache).toBe(
      false,
    );
  });

  it('accepts optional build_caches on AgentCapabilityReportSchema', () => {
    const base = {
      agent_id: 'agent_1',
      display_name: 'dev',
      hostname: 'host',
      os: { family: 'linux' as const, version: '6.1', arch: 'x64' },
      resources: {
        cpu_logical: 4,
        memory_total_mb: 8192,
        memory_free_mb: 4096,
        disk_free_mb: 1024,
      },
      execution: {
        max_jobs: 1,
        shells: ['bash'],
        supports_tty: true,
        supports_process_tree_kill: false,
      },
      tools: {},
      toolchain_profiles: [],
      labels: {},
      secret_refs: [],
    };

    expect(AgentCapabilityReportSchema.safeParse(base).success).toBe(true);

    const withCaches = AgentCapabilityReportSchema.safeParse({
      ...base,
      build_caches: [
        { kind: 'npm', keys: ['npm_abcdef0123456789abcdef0123456789'] },
        { kind: 'ccache' },
      ],
    });
    expect(withCaches.success).toBe(true);

    expect(
      AgentCapabilityReportSchema.safeParse({
        ...base,
        build_caches: [{ kind: 'cargo', keys: ['x'] }],
      }).success,
    ).toBe(false);

    expect(
      AgentCapabilityReportSchema.safeParse({
        ...base,
        build_caches: [{ kind: 'npm', keys: [''] }],
      }).success,
    ).toBe(false);
  });
});
