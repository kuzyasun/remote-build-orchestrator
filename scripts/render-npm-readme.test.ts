import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderNpmReadme, rewriteRelativeLinks } from './render-npm-readme.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('renderNpmReadme', () => {
  it('points relative docs links at the master branch and leaves absolute links', () => {
    const rendered = rewriteRelativeLinks(
      'See [guide](docs/user/getting-started.md#6-run-a-first-job) and [site](https://example.com).',
    );
    expect(rendered).toContain(
      'https://github.com/kuzyasun/remote-build-orchestrator/blob/master/docs/user/getting-started.md#6-run-a-first-job',
    );
    expect(rendered).toContain('https://example.com');
    expect(rendered).not.toContain('blob/main/');
  });

  it('does not rewrite links inside fenced code', () => {
    const rendered = rewriteRelativeLinks('```\n[x](docs/a.md)\n```\n');
    expect(rendered).toContain('[x](docs/a.md)');
  });

  it('matches the README shipped in @gemslibe/rbo', () => {
    const source = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const published = readFileSync(join(ROOT, 'apps', 'cli', 'README.md'), 'utf8');
    expect(published).toBe(renderNpmReadme(source));
    expect(published).toContain('separate commercial license');
    expect(published).not.toContain('](docs/');
  });
});
