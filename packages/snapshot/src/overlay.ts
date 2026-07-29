import type { GitStatusEntry, GitStatusSnapshot } from './git-status.js';
import { normalizeWirePath } from './git-status.js';

export interface OverlaySourcePolicy {
  include_untracked: boolean;
  include_ignored: string[];
}

export interface OverlayGitlinkPin {
  path: string;
  commit: string;
}

export interface OverlayPlan {
  /** Relative paths whose working-tree bytes must be shipped in the overlay archive. */
  files: string[];
  /** Relative paths that must be removed from the base worktree before applying files. */
  deletions: string[];
  /** Submodule gitlink pins (ordered parent-before-child). */
  gitlinks: OverlayGitlinkPin[];
}

export interface ComputeOverlayPlanOptions {
  stageModes?: Map<string, string>;
  gitlinkCommits?: Map<string, string>;
}

function isDeletionXy(xy: string): boolean {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  return x === 'D' || y === 'D';
}

/** True when either index or worktree side has a real change (not space/dot). */
function isInterestingTrackedChange(xy: string): boolean {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  const meaningful = (c: string) => c !== ' ' && c !== '.';
  return meaningful(x) || meaningful(y);
}

/**
 * Derive overlay file/deletion/gitlink sets from porcelain v2 status (§11.3 / Phase 5).
 * Pure: does not read the filesystem.
 */
export function computeOverlayPlan(
  status: GitStatusSnapshot,
  sourcePolicy: OverlaySourcePolicy,
  options?: ComputeOverlayPlanOptions,
): OverlayPlan {
  const files = new Set<string>();
  const deletions = new Set<string>();
  const gitlinksMap = new Map<string, string>();

  if (options?.gitlinkCommits) {
    for (const [path, commit] of options.gitlinkCommits) {
      gitlinksMap.set(path, commit);
    }
  }

  for (const entry of status.entries) {
    const path = normalizeWirePath(entry.path);
    const isGitlinkMode =
      options?.stageModes?.get(path) === '160000' || entry.submodule?.startsWith('S');

    if (isGitlinkMode) {
      if (isDeletionXy(entry.xy)) {
        deletions.add(path);
        gitlinksMap.delete(path);
      } else {
        const commit = options?.gitlinkCommits?.get(path);
        if (commit) {
          gitlinksMap.set(path, commit);
        }
      }
      continue;
    }

    if (entry.kind === 'untracked') {
      if (sourcePolicy.include_untracked) {
        files.add(path);
      }
      continue;
    }
    if (entry.kind === 'ignored') {
      if (sourcePolicy.include_ignored.some((pattern) => matchInclude(path, pattern))) {
        files.add(path);
      }
      continue;
    }

    // tracked
    if (entry.origPath) {
      deletions.add(normalizeWirePath(entry.origPath));
      files.add(path);
      continue;
    }

    if (isDeletionXy(entry.xy)) {
      deletions.add(path);
      // MD / DM etc.: still has non-delete change on the other side — ship current bytes.
      const x = entry.xy[0] ?? ' ';
      const y = entry.xy[1] ?? ' ';
      const other = x === 'D' ? y : x;
      if (other !== ' ' && other !== '.' && other !== 'D') {
        files.add(path);
        deletions.delete(path);
      }
      continue;
    }

    if (isInterestingTrackedChange(entry.xy)) {
      files.add(path);
    }
  }

  // A path cannot be both deleted and shipped.
  for (const path of files) {
    deletions.delete(path);
  }
  for (const path of deletions) {
    gitlinksMap.delete(path);
  }

  const gitlinksArr: OverlayGitlinkPin[] = Array.from(gitlinksMap.entries())
    .map(([path, commit]) => ({ path, commit }))
    .sort((a, b) => {
      const depthA = a.path.split('/').length;
      const depthB = b.path.split('/').length;
      if (depthA !== depthB) {
        return depthA - depthB;
      }
      return a.path.localeCompare(b.path);
    });

  return {
    files: [...files].sort(),
    deletions: [...deletions].sort(),
    gitlinks: gitlinksArr,
  };
}

function matchInclude(pathStr: string, pattern: string): boolean {
  if (pattern === pathStr) {
    return true;
  }
  if (pattern.endsWith('/') && pathStr.startsWith(pattern)) {
    return true;
  }
  // Simple glob: exact or trailing /**
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return pathStr === prefix || pathStr.startsWith(`${prefix}/`);
  }
  return pathStr === pattern;
}

/** Classify whether a porcelain entry contributes an overlay deletion. */
export function overlayDeletionPaths(entries: GitStatusEntry[]): string[] {
  const plan = computeOverlayPlan(
    { head: '', branch: null, entries },
    { include_untracked: false, include_ignored: [] },
  );
  return plan.deletions;
}
