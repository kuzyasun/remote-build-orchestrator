import { execFile } from 'node:child_process';
import { readFile, readdir, statfs } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCapabilityReport, BuildCacheKind } from '@rbo/protocol';
import { listPresentBuildCacheKeys } from '../build-cache/index.js';
import { resolveReposDir } from '../config.js';

const execFileAsync = promisify(execFile);

// Automatic capability probing (§9.2, §9.3): OS/arch/resources always come
// from the OS itself; shells and tool versions are detected best-effort so a
// missing tool degrades to "not offered" rather than a crash. Toolchain
// profiles and custom probe scripts are configuration-driven and arrive with
// the scheduler in a later phase.

function osFamily(): 'macos' | 'windows' | 'linux' {
  const p = platform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

async function probeFreeDiskBytes(path: string): Promise<number> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

async function detectShells(): Promise<string[]> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [
          ['powershell', ['-NoProfile', '-Command', 'exit']],
          ['cmd', ['/c', 'exit']],
          ['pwsh', ['-NoProfile', '-Command', 'exit']],
          ['bash', ['-c', 'exit']],
          ['sh', ['-c', 'exit']],
          ['zsh', ['-c', 'exit']],
        ]
      : [
          ['bash', ['-c', 'exit']],
          ['zsh', ['-c', 'exit']],
          ['sh', ['-c', 'exit']],
          ['pwsh', ['-NoProfile', '-Command', 'exit']],
        ];
  const found: string[] = [];
  for (const [name, args] of candidates) {
    try {
      await execFileAsync(name, args);
      found.push(name);
    } catch {
      // not present on this machine
    }
  }
  return found;
}

async function detectGitVersion(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? [match[1] as string] : [];
  } catch {
    return [];
  }
}

async function detectGitLfsVersion(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git-lfs', ['version']);
    const match = stdout.match(/git-lfs\/(\d+\.\d+\.\d+)/);
    return match ? [match[1] as string] : [];
  } catch {
    return [];
  }
}

export interface ProbeInput {
  agentId: string;
  displayName: string;
  maxJobs: number;
  /** When set, advertise repository_cache from mirror metadata (§19.2). */
  stateDir?: string;
  /** Mirror cache root override (§2.8). */
  repoCacheDir?: string;
  /** Phase 6 disk admission floor. */
  diskMinFreeBytes?: number;
  /** Build-cache kinds enabled on this agent (filters capability ads). */
  enabledBuildCacheKinds?: readonly BuildCacheKind[];
  /** Optional §19.2 configured_priority override from agent config. */
  configuredPriority?: number;
}

/** CPU busy fraction in [0, 1] from 1-minute load average vs logical CPUs. */
export function probeCpuLoad(): number {
  const [load1] = loadavg();
  const logical = cpus().length || 1;
  const fraction = load1 / logical;
  return Math.min(1, Math.max(0, fraction));
}

export type BuildCacheCapabilityAds = NonNullable<AgentCapabilityReport['build_caches']>;

export async function refreshBuildCacheCapabilityAds(input: {
  stateDir: string;
  enabledKinds: readonly BuildCacheKind[];
}): Promise<BuildCacheCapabilityAds | undefined> {
  const ads = await listPresentBuildCacheKeys(input.stateDir, input.enabledKinds);
  return ads.length > 0 ? ads : undefined;
}

export function applyRefreshedBuildCacheAds(
  current: Pick<AgentCapabilityReport, 'build_caches'>,
  refreshed: BuildCacheCapabilityAds | undefined,
): { changed: boolean; build_caches: BuildCacheCapabilityAds | undefined } {
  const prevJson = JSON.stringify(current.build_caches ?? null);
  const nextJson = JSON.stringify(refreshed ?? null);
  if (prevJson === nextJson) {
    return { changed: false, build_caches: refreshed };
  }
  return { changed: true, build_caches: refreshed };
}

async function loadRepositoryCache(
  stateDir: string,
  repoCacheDir?: string,
): Promise<NonNullable<AgentCapabilityReport['repository_cache']>> {
  const reposDir = resolveReposDir({ stateDir, repoCacheDir });
  try {
    const entries = await readdir(reposDir, { withFileTypes: true });
    const cache: NonNullable<AgentCapabilityReport['repository_cache']> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const raw = await readFile(join(reposDir, entry.name, 'metadata.json'), 'utf8');
        const meta = JSON.parse(raw) as { canonical_id?: string };
        if (meta.canonical_id) {
          cache.push({ canonical_id: meta.canonical_id });
        }
      } catch {
        // skip broken metadata
      }
    }
    return cache;
  } catch {
    return [];
  }
}

export async function probeCapabilities(input: ProbeInput): Promise<AgentCapabilityReport> {
  const shells = await detectShells();
  const gitVersions = await detectGitVersion();
  const gitLfsVersions = await detectGitLfsVersion();
  const repository_cache = input.stateDir
    ? await loadRepositoryCache(input.stateDir, input.repoCacheDir)
    : [];
  const enabledKinds = input.enabledBuildCacheKinds;
  const build_caches = input.stateDir
    ? await listPresentBuildCacheKeys(input.stateDir, enabledKinds)
    : [];
  const diskFreeBytes = input.stateDir ? await probeFreeDiskBytes(input.stateDir) : 0;
  const diskMinFreeBytes = input.diskMinFreeBytes ?? 0;
  const diskPressure = diskMinFreeBytes > 0 && diskFreeBytes < diskMinFreeBytes;

  return {
    agent_id: input.agentId,
    display_name: input.displayName,
    hostname: hostname(),
    os: {
      family: osFamily(),
      version: release(),
      arch: arch(),
    },
    resources: {
      cpu_logical: cpus().length,
      memory_total_mb: Math.round(totalmem() / (1024 * 1024)),
      memory_free_mb: Math.round(freemem() / (1024 * 1024)),
      disk_free_mb: Math.round(diskFreeBytes / (1024 * 1024)),
      cpu_load: probeCpuLoad(),
      disk_free_bytes: diskFreeBytes,
      ...(diskMinFreeBytes > 0 ? { disk_min_free_bytes: diskMinFreeBytes } : {}),
      disk_pressure: diskPressure,
      cpu_speed_mhz: cpus()[0]?.speed ?? undefined,
    },
    execution: {
      max_jobs: input.maxJobs,
      shells,
      supports_tty: process.platform !== 'win32',
      supports_process_tree_kill: process.platform === 'win32', // via native helper, wired in Phase 3
    },
    tools: {
      ...(gitVersions.length > 0 ? { git: gitVersions } : {}),
      ...(gitLfsVersions.length > 0 ? { 'git-lfs': gitLfsVersions } : {}),
    },
    toolchain_profiles: [],
    labels: {},
    secret_refs: [],
    accepting_jobs: !diskPressure,
    ...(repository_cache.length > 0 ? { repository_cache } : {}),
    ...(build_caches.length > 0 ? { build_caches } : {}),
    ...(input.configuredPriority !== undefined
      ? { configured_priority: input.configuredPriority }
      : {}),
  };
}
