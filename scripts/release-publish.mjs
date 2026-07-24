#!/usr/bin/env node
/**
 * Publish both packages to npm (optional package first, then @gemslibe/rbo).
 *
 * Safety gate: requires RELEASE_CONFIRM=1 or --yes / -y.
 * Does not bump versions or pack; run verify → build → bump-version → release:pack first.
 *
 * Prerequisites:
 *   npm login (account with publish rights under the gemslibe org)
 *
 * Usage (from repo root):
 *   RELEASE_CONFIRM=1 pnpm release:publish
 *   pnpm release:publish --yes
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTOR_DIR = join(ROOT, 'packages', 'rbo-windows-executor-win32-x64');
const CLI_DIR = join(ROOT, 'apps', 'cli');
const STAGED_EXE = join(EXECUTOR_DIR, 'bin', 'rbo-windows-executor.exe');
const CLI_BUNDLES = [join(CLI_DIR, 'dist', 'rbo.js'), join(CLI_DIR, 'dist', 'rbo-mcp-stdio.js')];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function confirmed() {
  const args = process.argv.slice(2);
  if (args.includes('--yes') || args.includes('-y')) {
    return true;
  }
  return process.env.RELEASE_CONFIRM === '1';
}

function shellQuote(arg) {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"&<>|^%!]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function run(command, args, opts = {}) {
  const line = [command, ...args].map(shellQuote).join(' ');
  console.log(`> ${line}`);
  const result = spawnSync(line, {
    cwd: opts.cwd ?? ROOT,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`);
  }
}

function main() {
  if (!confirmed()) {
    fail(
      'refusing to publish without confirmation.\n  Set RELEASE_CONFIRM=1 or pass --yes / -y.\n  Example (PowerShell):\n    $env:RELEASE_CONFIRM=1; pnpm release:publish\n    pnpm release:publish --yes\n  Requires: npm login to an account that can publish under the gemslibe org.',
    );
  }

  if (!existsSync(STAGED_EXE)) {
    fail(
      `missing ${STAGED_EXE}. Run \`pnpm release:pack\` on Windows x64 first (prepack also requires the exe).`,
    );
  }
  for (const bundle of CLI_BUNDLES) {
    if (!existsSync(bundle)) {
      fail(`missing ${bundle}. Run \`pnpm build\` then \`pnpm release:pack\` before publish.`);
    }
  }

  console.log('Publishing optional package first, then @gemslibe/rbo…');
  console.log('(npm login / gemslibe org membership + 2FA as required by npm)');

  run('npm', ['publish', '--access', 'public'], { cwd: EXECUTOR_DIR });
  run('npm', ['publish', '--access', 'public'], { cwd: CLI_DIR });

  console.log('release:publish ok — both packages published');
}

main();
