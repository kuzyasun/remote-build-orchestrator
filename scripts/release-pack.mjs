#!/usr/bin/env node
/**
 * Pack both publishable packages for a release.
 *
 * On Windows x64: cargo build --release, then prepare-binary:require, then pack
 * optional package then @gemslibe/rbo (via pnpm --dir … pack, not --filter).
 *
 * Usage (from repo root):
 *   pnpm release:pack
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTOR_DIR = join(ROOT, 'packages', 'rbo-windows-executor-win32-x64');
const CLI_DIR = join(ROOT, 'apps', 'cli');
const CARGO_MANIFEST = join(ROOT, 'native', 'windows-executor', 'Cargo.toml');
const STAGED_EXE = join(EXECUTOR_DIR, 'bin', 'rbo-windows-executor.exe');
const RELEASE_EXE = join(
  ROOT,
  'native',
  'windows-executor',
  'target',
  'release',
  'rbo-windows-executor.exe',
);
const CLI_BUNDLES = [join(CLI_DIR, 'dist', 'rbo.js'), join(CLI_DIR, 'dist', 'rbo-mcp-stdio.js')];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
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

function run(command, args) {
  const line = [command, ...args].map(shellQuote).join(' ');
  console.log(`> ${line}`);
  // Single shell string (not args+shell) — required on Windows for pnpm shims; avoids DEP0190.
  const result = spawnSync(line, {
    cwd: ROOT,
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
  const isWinX64 = platform() === 'win32' && arch() === 'x64';

  if (isWinX64) {
    run('cargo', ['build', '--release', '--manifest-path', CARGO_MANIFEST]);
  } else {
    console.warn(
      `warn: not Windows x64 (${platform()}/${arch()}); skipping cargo build. A staged or Cargo-built rbo-windows-executor.exe is still required to pack.`,
    );
  }

  run('pnpm', ['--filter', '@gemslibe/rbo-windows-executor-win32-x64', 'prepare-binary:require']);

  if (!existsSync(STAGED_EXE)) {
    fail(
      `missing ${STAGED_EXE}. Build on Windows x64:\n  cargo build --release --manifest-path native/windows-executor/Cargo.toml\n  pnpm --filter @gemslibe/rbo-windows-executor-win32-x64 prepare-binary:require`,
    );
  }

  for (const bundle of CLI_BUNDLES) {
    if (!existsSync(bundle)) {
      fail(
        `missing ${bundle}. Run \`pnpm verify\` (or \`pnpm --filter @gemslibe/rbo build\`) before pack.`,
      );
    }
  }

  if (!existsSync(RELEASE_EXE) && isWinX64) {
    fail(`missing Cargo release output at ${RELEASE_EXE} after cargo build --release`);
  }

  // pnpm 10: do not use --filter … pack (implies recursive; pack rejects it).
  run('pnpm', ['--dir', EXECUTOR_DIR, 'pack']);
  run('pnpm', ['--dir', CLI_DIR, 'pack']);

  console.log('release:pack ok — optional package then @gemslibe/rbo tarballs created');
}

main();
