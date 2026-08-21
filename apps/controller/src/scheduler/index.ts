import type {
  AgentCapabilityReport,
  BuildCacheKind,
  JobRequest,
  ToolchainProfileSchema,
} from '@rbo/protocol';
import { DEFAULT_REFERENCE_CAPACITY_SCORE, computeBuildCacheKey } from '@rbo/shared';
import type { z } from 'zod';
import type { ControllerDatabase } from '../storage/database.js';

type ToolchainProfile = z.infer<typeof ToolchainProfileSchema>;

/** §19.2 score formula constants — keep in sync with remote-build-orchestrator-design.md §19.2. */
export const SCHEDULER_SCORE_CONFIGURED_PRIORITY_MULTIPLIER = 1000;
export const SCHEDULER_SCORE_PREFERRED_AGENT_UNIT = 100;
export const SCHEDULER_SCORE_REPOSITORY_CACHE_HIT = 500;
export const SCHEDULER_SCORE_EXACT_TOOLCHAIN_MATCH = 200;
export const SCHEDULER_SCORE_PREFERRED_OS_UNIT = 10;
export const SCHEDULER_SCORE_RUNNING_JOBS_PENALTY = 300;
export const SCHEDULER_SCORE_CPU_LOAD_PENALTY = 100;
/** Phase 7 build_cache_hit preference — weaker than repository_cache_hit (* 500). */
export const SCHEDULER_SCORE_BUILD_CACHE_HIT = 250;

/** Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md) — v1 CPU-only threshold. */
export const DEFAULT_MAX_HOST_CPU_BUSY_FRACTION = 0.8;

/** §19.3 OS-family defaults when configured_priority is unset on the capability report. */
export const SCHEDULER_DEFAULT_PRIORITY_MACOS = 20;
export const SCHEDULER_DEFAULT_PRIORITY_WINDOWS = 10;
export const SCHEDULER_DEFAULT_PRIORITY_LINUX = 15;
export const SCHEDULER_DEFAULT_PRIORITY_LOCAL = -100;

/** Controller-computed recent_failure_penalty: min(500, failures * 50) over a fixed window. */
export const SCHEDULER_FAILURE_PENALTY_PER_FAILURE = 50;
export const SCHEDULER_FAILURE_PENALTY_MAX = 500;
export const SCHEDULER_RECENT_FAILURE_WINDOW = 10;

const MIB_BYTES = 1024 * 1024;

const TOOL_NAME_TO_BUILD_CACHE_KIND: Record<string, BuildCacheKind> = {
  ccache: 'ccache',
  sccache: 'sccache',
  npm: 'npm',
  pnpm: 'pnpm',
  pip: 'pip',
};

const TOOLCHAIN_REQUIRED_KINDS = new Set<BuildCacheKind>(['ccache', 'sccache']);

export interface SchedulerAgent {
  agentId: string;
  capabilities: AgentCapabilityReport;
  /** Controller-known non-terminal attempt count for this agent (§19.2 running_jobs). */
  activeJobsCount: number;
  /** Controller-computed recent_failure_penalty; defaults to 0 when omitted. */
  recentFailurePenalty?: number;
}

export interface SchedulingDecision {
  action: 'remote' | 'wait' | 'fail_fast' | 'local_fallback';
  selectedAgent?: SchedulerAgent;
  selectedToolchains?: ToolchainProfile[];
  reason?: string;
  /** Compact, request-scoped explanation when no remote Agent is currently eligible. */
  noMatchDiagnostic?: NoMatchingAgentDiagnostic;
}

/**
 * Intentionally excludes agent identity, hostname, paths, and complete capability reports.
 * It is safe to persist or log without revealing Agent details.
 */
export interface NoMatchingAgentDiagnostic {
  category: 'no_matching_agent';
  retryable: false;
  required_shell: string;
  target_os?: string[];
  hint: string;
}

export interface ExpectedBuildCacheKey {
  kind: BuildCacheKind;
  key: string;
}

export interface SchedulerOptions {
  allowLocalFallback?: boolean;
  /**
   * Controller-local execution contract. Omit only for direct scheduler/programmatic callers
   * that need the historical fallback behavior; production dispatch always supplies it.
   */
  localHostExecution?: LocalHostExecutionCapability;
  /**
   * Canonical repository id for the job (normalized). When set with
   * prefer_repo_cache, agents advertising a matching repository_cache entry
   * receive the §19.2 repository_cache_hit bonus (+500).
   */
  repoCanonicalId?: string | null;
  /** Optional base commit — bonus only if agent reports the commit OR omits commits (fetch path allowed). */
  baseCommit?: string | null;
  /**
   * Opaque build-cache identities expected for this job (tests / explicit).
   * When set with prefer_build_cache, agents advertising a matching kind+key receive
   * the build_cache_hit bonus (+250).
   */
  buildCacheKeys?: readonly ExpectedBuildCacheKey[] | null;
  /**
   * Project identity for per-agent build-cache key computation when
   * `buildCacheKeys` is not provided (`repo_key` or `local:<content_id>`).
   */
  buildCacheProjectIdentity?: string | null;
  /**
   * Known snapshot/overlay/bundle transfer size in bytes at schedule time.
   * Converted to `ceil(bytes / 1MiB)` for §19.2 estimated_transfer_mb.
   */
  estimatedTransferBytes?: number | null;
  /** Controller-computed recent_failure_penalty per agent id (§19.2). */
  recentFailurePenalties?: ReadonlyMap<string, number>;
  /** Registered, non-disabled Agents before the online connection filter is applied. */
  registeredAgentCount?: number;
  /**
   * Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md). When omitted, local
   * fallback behaves exactly as before (host load is not considered) — fully backward compatible.
   */
  hostLoad?: HostLoadSnapshot;
  /** CPU busy-fraction floor above which the host is excluded from local fallback consideration. */
  maxHostCpuBusyFraction?: number;
}

export interface HostLoadSnapshot {
  /** [0,1] — see packages/shared's sampleCpuBusyFraction. */
  cpuBusyFraction: number;
  /** packages/shared's computeCapacityScore(cpuLogical, cpuSpeedMhz, memoryFreeMb). */
  capacityScore: number;
  /** Currently-running local-fallback jobs on this Controller's own host. */
  runningJobs: number;
}

/** Conservative built-in shell set for the Controller host; optional shells are never assumed. */
export interface LocalHostExecutionCapability {
  os: 'windows' | 'linux' | 'macos';
  shells: readonly JobRequest['execution']['shell'][];
}

export interface LocalFallbackDecisionInput {
  allowLocalFallback: boolean;
  riskLevel: JobRequest['risk_level'];
  host: HostLoadSnapshot;
  maxHostCpuBusyFraction: number;
  /** Running-job counts of Agents currently excluded from selection only because they're at capacity. */
  busyAgentRunningJobs: readonly number[];
  /** Baseline capacity score a host is judged against; defaults to DEFAULT_REFERENCE_CAPACITY_SCORE. */
  referenceCapacityScore?: number;
}

export interface LocalFallbackDecision {
  eligible: boolean;
  /** Present whenever the host was over its effective CPU threshold, whichever way it landed. */
  reason?: 'host_busy';
}

/** Ceiling on the boosted threshold — a very powerful host still isn't treated as having no limit. */
const MAX_EFFECTIVE_HOST_CPU_BUSY_FRACTION = 0.97;

/**
 * A host stronger than `referenceCapacityScore` (an 8-core/3GHz baseline) earns headroom past the
 * flat `baseMaxFraction` threshold, scaled by how much more powerful it is — it finishes the same
 * job faster than an average machine would, so a higher busy reading is still an acceptable time
 * to take on local work. A host at or below the reference gets no boost (identical to pre-feature
 * behavior). Capped so an extreme outlier is never effectively unbounded.
 */
export function computeEffectiveMaxHostCpuBusyFraction(
  capacityScore: number,
  baseMaxFraction: number,
  referenceCapacityScore: number,
): number {
  if (referenceCapacityScore <= 0 || capacityScore <= referenceCapacityScore) {
    return baseMaxFraction;
  }
  const powerRatio = capacityScore / referenceCapacityScore;
  return Math.min(MAX_EFFECTIVE_HOST_CPU_BUSY_FRACTION, baseMaxFraction * powerRatio);
}

/**
 * Pure decision: should this job run on the Controller's own host right now?
 *
 * Below the host's *effective* CPU threshold (the flat threshold, boosted for a more-powerful-
 * than-average host via computeEffectiveMaxHostCpuBusyFraction), yes. At or above it, the host is
 * excluded from consideration UNLESS it's still the least-loaded of everything currently available
 * (including itself when no Agent exists at all) — running the job on an over-threshold-but-least-
 * bad host beats leaving it stuck in queue forever with nothing better to compare against.
 * Destructive/hardware risk jobs are excluded from local fallback regardless of load, exactly as
 * before — host load and power never weaken that safety rule.
 */
export function decideLocalFallback(input: LocalFallbackDecisionInput): LocalFallbackDecision {
  if (
    !input.allowLocalFallback ||
    input.riskLevel === 'destructive' ||
    input.riskLevel === 'hardware'
  ) {
    return { eligible: false };
  }

  const effectiveMaxFraction = computeEffectiveMaxHostCpuBusyFraction(
    input.host.capacityScore,
    input.maxHostCpuBusyFraction,
    input.referenceCapacityScore ?? DEFAULT_REFERENCE_CAPACITY_SCORE,
  );

  if (input.host.cpuBusyFraction < effectiveMaxFraction) {
    return { eligible: true };
  }

  const leastBusyOther =
    input.busyAgentRunningJobs.length > 0 ? Math.min(...input.busyAgentRunningJobs) : undefined;
  if (leastBusyOther === undefined || input.host.runningJobs <= leastBusyOther) {
    return { eligible: true, reason: 'host_busy' };
  }
  return { eligible: false, reason: 'host_busy' };
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

const MAX_DIAGNOSTIC_FIELD_BYTES = 16;
const MAX_DIAGNOSTIC_TARGET_OS = 3;

function truncateDiagnosticText(value: string, maxBytes = MAX_DIAGNOSTIC_FIELD_BYTES): string {
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function normalizedTargetOs(requestOs: string[] | undefined): string[] | undefined {
  if (!requestOs || requestOs.length === 0) {
    return undefined;
  }
  return [...new Set(requestOs.map((os) => os.trim().toLowerCase()).filter(Boolean))]
    .slice(0, MAX_DIAGNOSTIC_TARGET_OS)
    .map((os) => truncateDiagnosticText(os));
}

function normalizedShell(shell: string): string {
  return shell.replace(/\.exe$/i, '').toLowerCase();
}

function agentHasRequiredShell(agent: SchedulerAgent, requiredShell: string): boolean {
  return agent.capabilities.execution.shells.some(
    (shell) => normalizedShell(shell) === requiredShell,
  );
}

function agentIsAtCapacity(agent: SchedulerAgent): boolean {
  const capacity = agent.capabilities.execution.max_jobs;
  return capacity <= 0 || agent.activeJobsCount >= capacity;
}

function localHostCanExecute(
  request: JobRequest,
  localHost: LocalHostExecutionCapability,
): boolean {
  if (!matchesOs(request.requirements?.os, localHost.os)) {
    return false;
  }
  const requiredShell = normalizedShell(request.execution.shell ?? 'bash');
  return localHost.shells.some((shell) => normalizedShell(shell) === requiredShell);
}

/**
 * Summarize only the request and aggregate matching state. Never include individual Agent
 * capabilities: the diagnostic is exposed on a job failure and must remain compact.
 */
export function describeNoMatchingAgent(
  agents: readonly SchedulerAgent[],
  request: JobRequest,
  options: Pick<SchedulerOptions, 'registeredAgentCount'> = {},
): NoMatchingAgentDiagnostic {
  const requestedOs = request.requirements?.os;
  const targetOs = normalizedTargetOs(requestedOs);
  // Programmatic callers may bypass Zod's default; retain the existing bash default in that case.
  const requiredShell = normalizedShell(request.execution.shell ?? 'bash');
  const diagnosticShell = truncateDiagnosticText(requiredShell);
  const targetLabel = targetOs?.join(' or ') ?? 'the requested target OS';
  const base = {
    category: 'no_matching_agent' as const,
    retryable: false as const,
    required_shell: diagnosticShell,
    ...(targetOs ? { target_os: targetOs } : {}),
  };

  if (agents.length === 0) {
    return {
      ...base,
      hint:
        options.registeredAgentCount && options.registeredAgentCount > 0
          ? 'No registered Agent is online. Reconnect an Agent or use queue_policy="wait".'
          : 'No online Agent is available. Connect an Agent or use queue_policy="wait".',
    };
  }

  const osMatches = agents.filter((agent) => matchesOs(requestedOs, agent.capabilities.os.family));
  if (requestedOs && requestedOs.length > 0 && osMatches.length === 0) {
    return {
      ...base,
      hint: `No online Agent matches target_os ${targetLabel}. Choose target_os and shell supported by the same Agent.`,
    };
  }

  const shellMatches = osMatches.filter((agent) => agentHasRequiredShell(agent, requiredShell));
  if (shellMatches.length === 0) {
    return {
      ...base,
      hint: `No online Agent provides ${diagnosticShell} on ${targetLabel}. Specify shell and target_os supported by the same Agent.`,
    };
  }

  if (shellMatches.every(agentIsAtCapacity)) {
    return {
      ...base,
      hint: 'All online Agents matching shell and target_os are at capacity. Use queue_policy="wait" or retry when capacity is available.',
    };
  }

  return {
    ...base,
    hint: 'No online Agent satisfies the requested execution requirements.',
  };
}

/** §19.3 default configured_priority by OS family (remote agents). */
export function defaultConfiguredPriorityForOs(
  osFamily: AgentCapabilityReport['os']['family'],
): number {
  switch (osFamily) {
    case 'macos':
      return SCHEDULER_DEFAULT_PRIORITY_MACOS;
    case 'linux':
      return SCHEDULER_DEFAULT_PRIORITY_LINUX;
    default:
      return SCHEDULER_DEFAULT_PRIORITY_WINDOWS;
  }
}

export function resolveConfiguredPriority(caps: AgentCapabilityReport): number {
  if (caps.configured_priority !== undefined) {
    return caps.configured_priority;
  }
  return defaultConfiguredPriorityForOs(caps.os.family);
}

/** Missing cpu_load is treated as 1 (pessimistic) for scoring only. */
export function resolveCpuLoadForScoring(caps: AgentCapabilityReport): number {
  const load = caps.resources.cpu_load;
  if (load === undefined || !Number.isFinite(load)) {
    return 1;
  }
  return Math.min(1, Math.max(0, load));
}

export function computeEstimatedTransferMb(knownTransferBytes: number | null | undefined): number {
  if (!knownTransferBytes || knownTransferBytes <= 0) {
    return 0;
  }
  return Math.ceil(knownTransferBytes / MIB_BYTES);
}

export function computeRecentFailurePenalty(failureCount: number): number {
  if (failureCount <= 0) {
    return 0;
  }
  return Math.min(
    SCHEDULER_FAILURE_PENALTY_MAX,
    failureCount * SCHEDULER_FAILURE_PENALTY_PER_FAILURE,
  );
}

export interface SchedulerScoreContext {
  agentId: string;
  caps: AgentCapabilityReport;
  runningJobs: number;
  recentFailurePenalty: number;
  request: JobRequest;
  options: SchedulerOptions;
  selectedToolchains: ToolchainProfile[];
  toolsRequested: boolean;
  toolsMatched: boolean;
}

/**
 * Exact §19.2 score for one eligible agent, plus Phase 7 build_cache_hit (+250)
 * applied after all §19.2 terms.
 */
export function computeAgentSchedulerScore(ctx: SchedulerScoreContext): number {
  const prefs = ctx.request.preferences ?? {
    prefer_repo_cache: true,
    prefer_build_cache: true,
    allow_local_fallback: true,
  };
  const reqs = ctx.request.requirements ?? {};

  let score = 0;

  score += resolveConfiguredPriority(ctx.caps) * SCHEDULER_SCORE_CONFIGURED_PRIORITY_MULTIPLIER;

  if (prefs.agent_ids && prefs.agent_ids.length > 0) {
    const idx = prefs.agent_ids.indexOf(ctx.agentId);
    if (idx >= 0) {
      score += (prefs.agent_ids.length - idx) * SCHEDULER_SCORE_PREFERRED_AGENT_UNIT;
    }
  }

  if (prefs.os_order && prefs.os_order.length > 0) {
    const idx = prefs.os_order.indexOf(ctx.caps.os.family);
    if (idx >= 0) {
      score += (prefs.os_order.length - idx) * SCHEDULER_SCORE_PREFERRED_OS_UNIT;
    }
  }

  if (prefs.prefer_repo_cache !== false && ctx.options.repoCanonicalId) {
    if (
      agentHasRepoCacheHit(ctx.caps, ctx.options.repoCanonicalId, ctx.options.baseCommit ?? null)
    ) {
      score += SCHEDULER_SCORE_REPOSITORY_CACHE_HIT;
    }
  }

  if (ctx.toolsRequested && ctx.toolsMatched) {
    score += SCHEDULER_SCORE_EXACT_TOOLCHAIN_MATCH;
  }

  score -= ctx.runningJobs * SCHEDULER_SCORE_RUNNING_JOBS_PENALTY;
  score -= resolveCpuLoadForScoring(ctx.caps) * SCHEDULER_SCORE_CPU_LOAD_PENALTY;
  score -= computeEstimatedTransferMb(ctx.options.estimatedTransferBytes);
  score -= ctx.recentFailurePenalty;

  // Phase 7 additive extension — after all §19.2 terms.
  if (prefs.prefer_build_cache !== false) {
    const expected =
      ctx.options.buildCacheKeys && ctx.options.buildCacheKeys.length > 0
        ? ctx.options.buildCacheKeys
        : ctx.options.buildCacheProjectIdentity
          ? computeExpectedBuildCacheKeysForAgent({
              caps: ctx.caps,
              selectedToolchains: ctx.selectedToolchains,
              projectIdentity: ctx.options.buildCacheProjectIdentity,
              requiredTools: reqs.tools,
            })
          : [];
    if (expected.length > 0 && agentHasBuildCacheHit(ctx.caps, expected)) {
      score += SCHEDULER_SCORE_BUILD_CACHE_HIT;
    }
  }

  return score;
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

/**
 * Phase 7 build_cache_hit: kind + opaque key equality for at least one expected entry.
 * Preference only — never a hard filter.
 */
export function agentHasBuildCacheHit(
  caps: AgentCapabilityReport,
  expected: readonly ExpectedBuildCacheKey[],
): boolean {
  if (expected.length === 0) {
    return false;
  }
  const ads = caps.build_caches ?? [];
  for (const want of expected) {
    const entry = ads.find((a) => a.kind === want.kind);
    if (entry?.keys?.includes(want.key)) {
      return true;
    }
  }
  return false;
}

/**
 * Compute opaque keys this agent would serve for the job (kind ∩ tools / all kinds).
 * ccache/sccache skipped without a selected toolchain profile.
 */
export function computeExpectedBuildCacheKeysForAgent(input: {
  caps: AgentCapabilityReport;
  selectedToolchains: ToolchainProfile[];
  projectIdentity: string;
  requiredTools?: Record<string, string>;
}): ExpectedBuildCacheKey[] {
  const tools = input.requiredTools;
  let kinds: BuildCacheKind[];
  if (!tools || Object.keys(tools).length === 0) {
    kinds = ['ccache', 'sccache', 'npm', 'pnpm', 'pip'];
  } else {
    const fromTools = new Set<BuildCacheKind>();
    for (const toolName of Object.keys(tools)) {
      const kind = TOOL_NAME_TO_BUILD_CACHE_KIND[toolName.toLowerCase()];
      if (kind) {
        fromTools.add(kind);
      }
    }
    kinds = [...fromTools];
  }

  const primary = input.selectedToolchains[0];
  const out: ExpectedBuildCacheKey[] = [];
  for (const kind of kinds) {
    if (TOOLCHAIN_REQUIRED_KINDS.has(kind) && !primary) {
      continue;
    }
    const key = computeBuildCacheKey({
      kind,
      toolchainProfileId: primary?.id ?? 'none',
      toolchainFingerprint: primary?.environment_fingerprint ?? 'none',
      osFamily: input.caps.os.family,
      arch: input.caps.os.arch,
      projectIdentity: input.projectIdentity,
    });
    out.push({ kind, key });
  }
  return out;
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

const PROBE_TOOL_NAMES = new Set(['git', 'git-lfs']);

function splitRequestedTools(requestedTools: Record<string, string> | undefined): {
  probeTools: Record<string, string>;
  toolchainTools: Record<string, string>;
} {
  const probeTools: Record<string, string> = {};
  const toolchainTools: Record<string, string> = {};
  if (!requestedTools) {
    return { probeTools, toolchainTools };
  }
  for (const [name, spec] of Object.entries(requestedTools)) {
    if (PROBE_TOOL_NAMES.has(name.toLowerCase())) {
      probeTools[name] = spec;
    } else {
      toolchainTools[name] = spec;
    }
  }
  return { probeTools, toolchainTools };
}

function matchProbeTools(
  requestedTools: Record<string, string>,
  agentTools: AgentCapabilityReport['tools'],
): boolean {
  for (const [toolName, versionSpec] of Object.entries(requestedTools)) {
    const key =
      Object.keys(agentTools).find(
        (candidate) => candidate.toLowerCase() === toolName.toLowerCase(),
      ) ?? toolName;
    const versions = agentTools[key];
    if (!versions || versions.length === 0) {
      return false;
    }
    if (!versions.some((version) => matchesVersionSpec(version, versionSpec))) {
      return false;
    }
  }
  return true;
}

/** Match toolchain profiles plus Agent-probed tools (git, git-lfs). */
export function matchJobToolRequirements(
  requestedTools: Record<string, string> | undefined,
  caps: AgentCapabilityReport,
): { matches: boolean; selectedProfiles: ToolchainProfile[] } {
  const { probeTools, toolchainTools } = splitRequestedTools(requestedTools);
  const toolchainMatch = matchToolchainProfiles(
    Object.keys(toolchainTools).length > 0 ? toolchainTools : undefined,
    caps.toolchain_profiles ?? [],
  );
  if (!toolchainMatch.matches) {
    return { matches: false, selectedProfiles: [] };
  }
  if (!matchProbeTools(probeTools, caps.tools ?? {})) {
    return { matches: false, selectedProfiles: [] };
  }
  return toolchainMatch;
}

export function selectAgentForJob(
  agents: SchedulerAgent[],
  request: JobRequest,
  options: SchedulerOptions = {},
): SchedulingDecision {
  const reqs = request.requirements ?? {};
  const prefs = request.preferences ?? {
    prefer_repo_cache: true,
    prefer_build_cache: true,
    allow_local_fallback: true,
  };

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
  // Agents excluded ONLY for being at capacity right now — used by the host-aware local-fallback
  // tie-break (§4 of the plan) as "who's the least-loaded of everything currently unavailable".
  const busyAgentRunningJobs: number[] = [];

  for (const candidate of agents) {
    const caps = candidate.capabilities;

    // 1. Capacity: honor agent-reported execution.max_jobs (from agent.json / capabilities).
    const effectiveCapacity = caps.execution.max_jobs;
    if (effectiveCapacity <= 0 || candidate.activeJobsCount >= effectiveCapacity) {
      if (effectiveCapacity > 0) {
        busyAgentRunningJobs.push(candidate.activeJobsCount);
      }
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
    const requiredShell = normalizedShell(request.execution.shell ?? 'bash');
    const hasShell = agentHasRequiredShell(candidate, requiredShell);
    if (!hasShell) {
      continue;
    }

    // 8. Secret refs filter
    if (!matchesSecretRefs(requiredSecrets, caps.secret_refs ?? [])) {
      continue;
    }

    // 9. Toolchain filter & profile resolution (one profile per requested tool)
    const toolMatch = matchJobToolRequirements(reqs.tools, caps);
    if (!toolMatch.matches) {
      continue;
    }

    // Scoring (§19.2 + Phase 7 build_cache_hit)
    const toolsRequested = Boolean(reqs.tools && Object.keys(reqs.tools).length > 0);
    const recentFailurePenalty =
      candidate.recentFailurePenalty ?? options.recentFailurePenalties?.get(candidate.agentId) ?? 0;

    const score = computeAgentSchedulerScore({
      agentId: candidate.agentId,
      caps,
      runningJobs: candidate.activeJobsCount,
      recentFailurePenalty,
      request,
      options,
      selectedToolchains: toolMatch.selectedProfiles,
      toolsRequested,
      toolsMatched: toolMatch.matches,
    });

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
  const noMatchDiagnostic = describeNoMatchingAgent(agents, request, options);

  if (queuePolicy === 'wait') {
    return { action: 'wait', reason: 'no_eligible_agent' };
  }

  if (queuePolicy === 'fail_fast') {
    return { action: 'fail_fast', reason: 'no_eligible_agent', noMatchDiagnostic };
  }

  // local_fallback — hardware/destructive remain ineligible (§19 / Phase 4)
  const riskLevel = request.risk_level ?? 'normal';
  const allowLocalFallback =
    (prefs.allow_local_fallback ?? true) && (options.allowLocalFallback ?? true);

  // Production injects a conservative host capability. Preserve the historical pure-scheduler
  // behavior when it is omitted, but never run an explicit incompatible shell/OS locally.
  if (options.localHostExecution && !localHostCanExecute(request, options.localHostExecution)) {
    return { action: 'fail_fast', reason: 'no_eligible_agent', noMatchDiagnostic };
  }

  if (options.hostLoad) {
    const decision = decideLocalFallback({
      allowLocalFallback,
      riskLevel,
      host: options.hostLoad,
      maxHostCpuBusyFraction: options.maxHostCpuBusyFraction ?? DEFAULT_MAX_HOST_CPU_BUSY_FRACTION,
      busyAgentRunningJobs,
    });
    if (decision.eligible) {
      return { action: 'local_fallback' };
    }
    return decision.reason === 'host_busy'
      ? { action: 'wait', reason: 'host_busy' }
      : { action: 'fail_fast', reason: 'no_eligible_agent', noMatchDiagnostic };
  }

  // No host load reading supplied — unchanged, backward-compatible behavior.
  if (allowLocalFallback && riskLevel !== 'destructive' && riskLevel !== 'hardware') {
    return { action: 'local_fallback' };
  }

  return { action: 'fail_fast', reason: 'no_eligible_agent', noMatchDiagnostic };
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

export function getRecentFailurePenaltiesForAgents(
  db: ControllerDatabase,
  windowSize = SCHEDULER_RECENT_FAILURE_WINDOW,
): Map<string, number> {
  const penalties = new Map<string, number>();
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT agent_id, outcome,
           ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY finished_at DESC) AS rn
         FROM job_attempts
         WHERE agent_id IS NOT NULL AND finished_at IS NOT NULL
       )
       SELECT agent_id, SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM ranked
       WHERE rn <= ?
       GROUP BY agent_id`,
    )
    .all(windowSize) as Array<{ agent_id: string; failures: number }>;

  for (const row of rows) {
    penalties.set(row.agent_id, computeRecentFailurePenalty(Number(row.failures)));
  }
  return penalties;
}
