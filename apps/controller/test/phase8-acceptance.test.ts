import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

// Bare filenames in the checklist (e.g. `phase8-smoke.test.ts` without a directory) are resolved
// against these known test roots, so the doc can stay terse without the citation being unverifiable.
const TEST_ROOTS = [
  'apps/controller/test',
  'apps/agent/test',
  'apps/cli/test',
  'packages/protocol/test',
  'packages/snapshot/test',
  'packages/executor/test',
  'packages/shared/test',
  'packages/testing/test',
];

async function pathExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** A glob-style citation like `scheduler*.test.ts` — true if at least one matching file exists. */
async function globCitationMatches(p: string): Promise<boolean> {
  const abs = join(ROOT, p);
  const dir = dirname(abs);
  const pattern = new RegExp(
    `^${abs
      .slice(dir.length + 1)
      .replace(/[.]/g, '\\.')
      .replace(/\*/g, '.*')}$`,
  );
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  return entries.some((name) => pattern.test(name));
}

async function citedFileExists(p: string): Promise<boolean> {
  if (p.includes('*')) {
    return globCitationMatches(p);
  }
  if (p.includes('/')) {
    return pathExists(join(ROOT, p));
  }
  for (const root of TEST_ROOTS) {
    if (await pathExists(join(ROOT, root, p))) return true;
  }
  return pathExists(join(ROOT, p));
}

describe('Phase 8 §37 acceptance checklist', () => {
  it('lists all 23 criteria with status and link', async () => {
    const doc = await readFile(
      join(process.cwd(), 'docs', 'acceptance', 'phase8-section37.md'),
      'utf8',
    );
    const rows = [...doc.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
    expect(rows).toEqual([...Array.from({ length: 23 }, (_, i) => i + 1)]);
    expect(doc).toMatch(/\bpass\b/);
    expect(doc).toMatch(/environment_gated|not_verified/);
    // Every pass/not_verified/environment_gated row should cite a path-like link
    expect(doc).toMatch(/phase8-smoke\.test\.ts|matrix\.json|threat/);
  });

  it('every concrete file/test citation in the checklist actually exists on disk', async () => {
    const doc = await readFile(
      join(process.cwd(), 'docs', 'acceptance', 'phase8-section37.md'),
      'utf8',
    );
    const rows = doc.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line));
    expect(rows.length).toBe(23);

    const pathPattern = /([\w.*-]+(?:\/[\w.*-]+)*\.(?:ts|md|json))/g;
    const cited = new Set<string>();
    for (const row of rows) {
      for (const match of row.matchAll(pathPattern)) {
        cited.add(match[1]);
      }
    }
    // Sanity: most of the 23 rows do cite a concrete, checkable path — if this drops, the
    // regression above (matching only 3 generic keywords) would have been silently satisfied.
    expect(cited.size).toBeGreaterThan(10);

    const missing: string[] = [];
    for (const p of cited) {
      if (!(await citedFileExists(p))) missing.push(p);
    }
    expect(missing, `checklist cites files that do not exist: ${missing.join(', ')}`).toEqual([]);
  });
});
