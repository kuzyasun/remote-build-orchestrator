import type { AgentCapabilityReport, JobRequest, ToolchainProfileSchema } from '@rbo/protocol';
import type { z } from 'zod';
import type { ControllerDatabase } from '../storage/database.js';

type ToolchainProfile = z.infer<typeof ToolchainProfileSchema>;

export interface SchedulerAgent {
  agentId: string;
  capabilities: AgentCapabilityReport;
  activeJobsCount: number;
}

export interface SchedulingDecision {
  action: 'remote' | 'wait' | 'fail_fast' | 'local_fallback';
  selectedAgent?: SchedulerAgent;
  selectedToolchains?: ToolchainProfile[];
  reason?: string;
}

export interface SchedulerOptions {
  allowLocalFallback?: boolean;
  /**
   * Canonical repository id for the job (normalized). When set with
   * prefer_repo_cache, agents advertising a matching repository_cache entry
   * receive the §19.2 repository_cache_hit bonus (+500).
   */
  repoCanonicalId?: string | null;
  /** Optional base commit — bonus only if agent reports the commit OR omits commits (fetch path allowed). */
  baseCommit?: string | null;
}

function matchesOs(requestOs?: string[], agentOs?: string): boolean {
  if (!requestOs || requestOs.length === 0) {
    return true;
  }
  if (!agentOs) {
    return false;
  }
  return requestOs.some((os) => os.toLowerCase() === agentOs.toLowerCase());
}

function matchesArch(requestArch?: string[], agentArch?: string): boolean {
  if (!requestArch || requestArch.length === 0) {
    return true;
  }
  if (!agentArch) {
    return false;
  }
  return requestArch.some((arch) => arch.toLowerCase() === agentArch.toLowerCase());
}

function matchesLabels(
  requestLabels?: Record<string, string>,
  agentLabels?: Record<string, string>,
): boolean {
  if (!requestLabels || Object.keys(requestLabels).length === 0) {
    return true;
  }
  if (!agentLabels) {
    return false;
  }
  for (const [key, val] of Object.entries(requestLabels)) {
    if (agentLabels[key] !== val) {
      return false;
    }
  }
  return true;
}

function matchesSecretRefs(requestRefs: string[], agentRefs: string[]): boolean {
  if (requestRefs.length === 0) {
    return true;
  }
  const agentSet = new Set(agentRefs);
  return requestRefs.every((ref) => agentSet.has(ref));
}

/** §19.2 repository_cache_hit: same canonical repo and base commit (or allowed fetch path). */
export function agentHasRepoCacheHit(
  caps: AgentCapabilityReport,
  repoCanonicalId: string,
  baseCommit: string | null,
): boolean {
  const entries = caps.repository_cache ?? [];
  for (const entry of entries) {
    if (entry.canonical_id !== repoCanonicalId) {
      continue;
    }
    if (!baseCommit) {
      return true;
    }
    // If the agent does not list commits, treat as "allowed fetch path" for affinity.
    if (!entry.commits || entry.commits.length === 0) {
      return true;
    }
    return entry.commits.includes(baseCommit);
  }
  return false;
}

/** Compare dotted numeric versions; non-numeric segments compared as strings. */
function compareVersionParts(a: string, b: string): number {
  const ap = a.split('.');
  const bp = b.split('.');
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i += 1) {
    const av = ap[i] ?? '0';
    const bv = bp[i] ?? '0';
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) {
        return an < bn ? -1 : 1;
      }
      continue;
    }
    if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Phase 4 version matching: `*`/`any`, exact equality, dot-bounded prefix
 * (e.g. `1.93` matches `1.93.0`), and simple `>=` / `>` / `<=` / `<` ranges.
 */
export function matchesVersionSpec(version: string, spec: string): boolean {
  const v = version.trim();
  const trimmed = spec.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'any') {
    return true;
  }
  if (v === trimmed) {
    return true;
  }

  const range = /^(>=|<=|>|<)\s*(.+)$/.exec(trimmed);
  if (range) {
    const op = range[1];
    const target = range[2].trim();
    const cmp = compareVersionParts(v, target);
    switch (op) {
      case '>=':
        return cmp >= 0;
      case '>':
        return cmp > 0;
      case '<=':
        return cmp <= 0;
      case '<':
        return cmp < 0;
      default:
        return false;
    }
  }

  // Dot-bounded prefix: "1.93" matches "1.93.0" but not "1.930" or "1.9".
  if (/^\d+(?:\.\d+)*$/.test(trimmed) && v.startsWith(`${trimmed}.`)) {
    return true;
  }

  return false;
}

function matchToolchainProfiles(
  requestedTools: Record<string, string> | undefined,
  agentProfiles: ToolchainProfile[],
): { matches: boolean; selectedProfiles: ToolchainProfile[] } {
  if (!requestedTools || Object.keys(requestedTools).length === 0) {
    return { matches: true, selectedProfiles: [] };
  }

  const selectedProfiles: ToolchainProfile[] = [];

  for (const [toolName, versionSpec] of Object.entries(requestedTools)) {
    const matched = agentProfiles.find((profile) => {
      const kindMatches =
        profile.kind.toLowerCase() === toolName.toLowerCase() ||
        profile.id.toLowerCase() === toolName.toLowerCase();
      if (!kindMatches) {
        return false;
      }
      return matchesVersionSpec(profile.version, versionSpec);
    });

    if (!matched) {
      return { matches: false, selectedProfiles: [] };
    }
    selectedProfiles.push(matched);
  }

  return { matches: true, selectedProfiles };
}

export function selectAgentForJob(
  agents: SchedulerAgent[],
  request: JobRequest,
  options: SchedulerOptions = {},
): SchedulingDecision {
  const reqs = request.requirements ?? {};
  const prefs = request.preferences ?? { prefer_repo_cache: true, allow_local_fallback: true };

  // Gather required secret store refs (requirements list + execution map values).
  // Wire form for execution.secret_refs is { ENV_NAME: "store_ref" } (§13.4).
  const requiredSecrets = [
    ...(reqs.secret_refs ?? []),
    ...Object.values(request.execution.secret_refs ?? {}),
  ];

  // Hard Filter
  const eligibleCandidates: Array<{
    agent: SchedulerAgent;
    toolchains: ToolchainProfile[];
    score: number;
  }> = [];

  for (const candidate of agents) {
    const caps = candidate.capabilities;

    // 1. Effective capacity check (§35 Phase 4 rule 3: min(max_jobs, 1))
    const effectiveCapacity = Math.min(caps.execution.max_jobs, 1);
    if (effectiveCapacity <= 0 || candidate.activeJobsCount >= effectiveCapacity) {
      continue;
    }

    // 2. OS filter
    if (!matchesOs(reqs.os, caps.os.family)) {
      continue;
    }

    // 3. Arch filter
    if (!matchesArch(reqs.arch, caps.os.arch)) {
      continue;
    }

    // 4. Labels filter
    if (!matchesLabels(reqs.labels, caps.labels)) {
      continue;
    }

    // 5. Memory filter
    if (reqs.min_memory_mb && caps.resources.memory_free_mb < reqs.min_memory_mb) {
      continue;
    }

    // 6. Disk filter
    if (reqs.min_disk_mb && caps.resources.disk_free_mb < reqs.min_disk_mb) {
      continue;
    }

    // 7. Required shell (§19.1)
    const requiredShell = request.execution.shell ?? 'bash';
    if (!caps.execution.shells.map((s) => s.toLowerCase()).includes(requiredShell.toLowerCase())) {
      continue;
    }

    // 8. Secret refs filter
    if (!matchesSecretRefs(requiredSecrets, caps.secret_refs ?? [])) {
      continue;
    }

    // 9. Toolchain filter & profile resolution (one profile per requested tool)
    const toolMatch = matchToolchainProfiles(reqs.tools, caps.toolchain_profiles ?? []);
    if (!toolMatch.matches) {
      continue;
    }

    // Scoring (§19.2)
    let score = 0;

    // Preference: agent_ids ranking
    if (prefs.agent_ids && prefs.agent_ids.length > 0) {
      const idx = prefs.agent_ids.indexOf(candidate.agentId);
      if (idx >= 0) {
        score += (prefs.agent_ids.length - idx) * 100;
      }
    }

    // Preference: os_order ranking
    if (prefs.os_order && prefs.os_order.length > 0) {
      const idx = prefs.os_order.indexOf(caps.os.family);
      if (idx >= 0) {
        score += (prefs.os_order.length - idx) * 10;
      }
    }

    // Memory headroom score
    score += Math.floor(caps.resources.memory_free_mb / 1024);

    // Repository cache affinity (§19.2) — preference only, after hard filters.
    if (prefs.prefer_repo_cache !== false && options.repoCanonicalId) {
      if (agentHasRepoCacheHit(caps, options.repoCanonicalId, options.baseCommit ?? null)) {
        score += 500;
      }
    }

    eligibleCandidates.push({
      agent: candidate,
      toolchains: toolMatch.selectedProfiles,
      score,
    });
  }

  if (eligibleCandidates.length > 0) {
    // Sort by score descending, tie-breaker: agentId ascending (deterministic)
    eligibleCandidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.agent.agentId.localeCompare(b.agent.agentId);
    });

    const chosen = eligibleCandidates[0];
    return {
      action: 'remote',
      selectedAgent: chosen.agent,
      selectedToolchains: chosen.toolchains.length > 0 ? chosen.toolchains : undefined,
    };
  }

  // Fallback Handling Table (§35 Phase 4)
  const queuePolicy = request.queue_policy ?? 'local_fallback';

  if (queuePolicy === 'wait') {
    return { action: 'wait', reason: 'no_eligible_agent' };
  }

  if (queuePolicy === 'fail_fast') {
    return { action: 'fail_fast', reason: 'no_eligible_agent' };
  }

  // local_fallback — hardware/destructive remain ineligible (§19 / Phase 4)
  const riskLevel = request.risk_level ?? 'normal';
  const allowLocalFallback =
    (prefs.allow_local_fallback ?? true) &&
    (options.allowLocalFallback ?? true) &&
    riskLevel !== 'destructive' &&
    riskLevel !== 'hardware';
  if (allowLocalFallback) {
    return { action: 'local_fallback' };
  }

  return { action: 'fail_fast', reason: 'no_eligible_agent' };
}

export function getActiveJobsForAgents(db: ControllerDatabase): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = db
    .prepare(
      `SELECT agent_id, COUNT(*) as count
       FROM job_attempts
       WHERE state IN ('leasing', 'preparing_source', 'transferring_source', 'materializing', 'starting', 'running', 'collecting_artifacts', 'cleaning')
       AND agent_id IS NOT NULL
       GROUP BY agent_id`,
    )
    .all() as Array<{ agent_id: string; count: number }>;

  for (const row of rows) {
    counts.set(row.agent_id, Number(row.count));
  }
  return counts;
}
