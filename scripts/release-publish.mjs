#!/usr/bin/env node
/**
 * Publish both packages to npm (optional package first, then @gemslibe/rbo).
 *
 * Safety gate: requires RELEASE_CONFIRM=1 or --yes / -y.
 * Does not bump versions or pack; run verify → build → bump-version → release:pack first.
 *
 * Authentication:
 *   - npm Trusted Publishing (OIDC) in GitHub Actions, or
 *   - npm login for the manual fallback
 *
 * Usage (from repo root):
 *   RELEASE_CONFIRM=1 pnpm release:publish
 *   pnpm release:publish --yes
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTOR_DIR = join(ROOT, 'packages', 'rbo-windows-executor-win32-x64');
const CLI_DIR = join(ROOT, 'apps', 'cli');
const STAGED_EXE = join(EXECUTOR_DIR, 'bin', 'rbo-windows-executor.exe');
const CLI_BUNDLES = [join(CLI_DIR, 'dist', 'rbo.js'), join(CLI_DIR, 'dist', 'rbo-mcp-stdio.js')];

function packedTarball(packageDir) {
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const filename = `${packageJson.name.replace(/^@/, '').replaceAll('/', '-')}-${packageJson.version}.tgz`;
  return join(packageDir, filename);
}

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
      'refusing to publish without confirmation.\n  Set RELEASE_CONFIRM=1 or pass --yes / -y.\n  Example (PowerShell):\n    $env:RELEASE_CONFIRM=1; pnpm release:publish\n    pnpm release:publish --yes\n  Authentication: npm Trusted Publishing in GitHub Actions, or npm login for the manual fallback.',
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
  const executorTarball = packedTarball(EXECUTOR_DIR);
  const cliTarball = packedTarball(CLI_DIR);
  for (const tarball of [executorTarball, cliTarball]) {
    if (!existsSync(tarball)) {
      fail(`missing ${tarball}. Run \`pnpm release:pack\` before publish.`);
    }
  }

  console.log('Publishing optional package first, then @gemslibe/rbo…');
  const usingTrustedPublishing = Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
  console.log(
    usingTrustedPublishing
      ? '(npm Trusted Publishing via GitHub Actions OIDC)'
      : '(interactive npm authentication with @gemslibe publish access required)',
  );

  run('npm', ['publish', '--access', 'public', executorTarball], { cwd: EXECUTOR_DIR });
  run('npm', ['publish', '--access', 'public', cliTarball], { cwd: CLI_DIR });

  console.log('release:publish ok — both packages published');
}

main();
