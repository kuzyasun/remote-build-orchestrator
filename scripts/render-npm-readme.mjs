#!/usr/bin/env node
/**
 * Write apps/cli/README.md from the repository README so the npm page matches GitHub.
 * Relative links are rewritten to blob/raw URLs: npm does not resolve them, and the
 * default branch is master (not main).
 *
 * Usage: node scripts/render-npm-readme.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/kuzyasun/remote-build-orchestrator';
const BRANCH = 'master';

const PACKAGE_NOTES = `
## Installed package

Global reinstall and uninstall run \`scripts/stop-running-rbo.mjs\` so a running Controller or Agent
does not lock native files on Windows. Only a global install triggers that stop. Set
\`RBO_SKIP_INSTALL_STOP=1\` to skip it.

On Windows x64, \`@gemslibe/rbo\` optionally installs \`@gemslibe/rbo-windows-executor-win32-x64\`.
Other platforms skip that helper.

**Default terms: [AGPL-3.0-only](${REPO}/blob/${BRANCH}/LICENSE).**

- Using RBO locally as a tool on your own machines is permitted under the AGPL.
- Offering RBO (or a modified or embedded form) as a network service, or embedding it into a
  proprietary product without complying with the AGPL, requires a separate commercial license
  from the copyright holder.

To request a commercial license, contact Serge Martyniuk at
[smdev42@proton.me](mailto:smdev42@proton.me).
`;

export function rewriteRelativeLinks(markdown) {
  const segments = markdown.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment, index) => (index % 2 === 1 ? segment : rewriteSegment(segment)))
    .join('');
}

function rewriteSegment(text) {
  return text.replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/g, (full, bang, label, target) => {
    const next = rewriteTarget(target.trim(), bang === '!');
    return next ? `${bang}[${label}](${next})` : full;
  });
}

function rewriteTarget(target, isImage) {
  if (/^(?:https?:|mailto:|#)/i.test(target)) {
    return null;
  }
  const hashAt = target.indexOf('#');
  const pathPart = (hashAt === -1 ? target : target.slice(0, hashAt)).replace(/^\.\//, '');
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  if (!pathPart || pathPart.startsWith('/')) {
    return null;
  }
  const kind = isImage ? 'raw' : 'blob';
  return `${REPO}/${kind}/${BRANCH}/${pathPart}${hash}`;
}

export function renderNpmReadme(source) {
  const body = rewriteRelativeLinks(source).trimEnd();
  return `${body}\n${PACKAGE_NOTES}`;
}

function isDirectRun() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const source = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const outPath = join(ROOT, 'apps', 'cli', 'README.md');
  writeFileSync(outPath, renderNpmReadme(source), 'utf8');
  console.log(`wrote ${outPath}`);
}
