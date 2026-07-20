import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCapabilityReport } from '@rbo/protocol';

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

async function detectShells(): Promise<string[]> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [
          ['powershell', ['-NoProfile', '-Command', 'exit']],
          ['cmd', ['/c', 'exit']],
        ]
      : [
          ['bash', ['-c', 'exit']],
          ['sh', ['-c', 'exit']],
          ['zsh', ['-c', 'exit']],
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

export interface ProbeInput {
  agentId: string;
  displayName: string;
  maxJobs: number;
  /** When set, advertise repository_cache from mirror metadata (§19.2). */
  stateDir?: string;
}

async function loadRepositoryCache(
  stateDir: string,
): Promise<NonNullable<AgentCapabilityReport['repository_cache']>> {
  const reposDir = join(stateDir, 'repos');
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
  const repository_cache = input.stateDir ? await loadRepositoryCache(input.stateDir) : [];

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
      disk_free_mb: 0, // TODO(Phase 3): real disk-free probe per platform
    },
    execution: {
      max_jobs: input.maxJobs,
      shells,
      supports_tty: process.platform !== 'win32',
      supports_process_tree_kill: process.platform === 'win32', // via native helper, wired in Phase 3
    },
    tools: gitVersions.length > 0 ? { git: gitVersions } : {},
    toolchain_profiles: [],
    labels: {},
    secret_refs: [],
    ...(repository_cache.length > 0 ? { repository_cache } : {}),
  };
}
