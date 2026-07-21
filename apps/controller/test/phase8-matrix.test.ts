import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CompatibilityMatrixSchema } from '@rbo/protocol';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd());
const MATRIX_PATH = join(ROOT, 'docs', 'compatibility', 'matrix.json');
const SNIPPETS_DIR = join(ROOT, 'docs', 'compatibility', 'snippets');

describe('Phase 8 compatibility matrix', () => {
  it('parses matrix.json against CompatibilityMatrixSchema', async () => {
    const raw = JSON.parse(await readFile(MATRIX_PATH, 'utf8'));
    const matrix = CompatibilityMatrixSchema.parse(raw);
    expect(matrix.cells.length).toBeGreaterThanOrEqual(12);

    const clients = new Set(matrix.cells.map((c) => c.client));
    for (const required of [
      'fusion',
      'codex',
      'claude',
      'cursor',
      'antigravity',
      'test-mcp-client',
    ]) {
      expect(clients.has(required)).toBe(true);
    }

    for (const cell of matrix.cells) {
      if (cell.status === 'verified') {
        expect(cell.evidence_path).toBeTruthy();
        const evidence = await readFile(join(ROOT, cell.evidence_path as string), 'utf8');
        expect(evidence.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps snippets free of secrets and developer absolute home paths', async () => {
    const files = await readdir(SNIPPETS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const text = await readFile(join(SNIPPETS_DIR, file), 'utf8');
      expect(text).not.toMatch(/BEGIN (OPENSSH |RSA )?PRIVATE KEY/);
      expect(text).not.toMatch(/[A-Za-z]:\\Users\\[^\\\s]+\\/);
      expect(text).not.toMatch(/\/home\/[^/\s]+\//);
      expect(text).toMatch(/\$\{RBO_ROOT\}|127\.0\.0\.1:7410/);
    }
  });
});
