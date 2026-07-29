/**
 * Docker CLI may return truncated IDs (e.g. 12 hex chars from `ps -aq` /
 * `network ls -q`) or full 64-char IDs (e.g. from `run -d` / `network create`).
 * Named volumes are returned as names from both create and ls.
 *
 * Two identifiers refer to the same object when equal, or when one is a
 * non-empty prefix of the other (Docker short-ID convention).
 */
export function dockerIdsEqual(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length === 0 || y.length === 0) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** True if any ID in `ids` matches `expected` under {@link dockerIdsEqual}. */
export function dockerIdListContains(ids: readonly string[], expected: string): boolean {
  return ids.some((id) => dockerIdsEqual(id, expected));
}

/**
 * Parse newline-separated Docker list output and check whether it contains
 * an ID matching `expected` (short or full).
 */
export function dockerListOutputContains(stdout: string, expected: string): boolean {
  const ids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return dockerIdListContains(ids, expected);
}
