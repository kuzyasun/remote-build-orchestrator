/**
 * Copy the Rust release binary into this package's bin/ for npm pack/publish.
 *
 * Usage:
 *   node scripts/copy-binary.mjs           # soft: warn and exit 0 if missing (local layout checks)
 *   node scripts/copy-binary.mjs --require # hard: exit 1 if neither cargo output nor staged bin exists
 *                                          # (prepack / npm publish / prepare-binary:require)
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '../..');
const requireBinary = process.argv.includes('--require');

const sources = [
  join(repoRoot, 'native/windows-executor/target/release/rbo-windows-executor.exe'),
  join(repoRoot, 'native/windows-executor/target/debug/rbo-windows-executor.exe'),
];

const destDir = join(pkgRoot, 'bin');
const dest = join(destDir, 'rbo-windows-executor.exe');

const source = sources.find((p) => existsSync(p));
if (!source) {
  if (existsSync(dest)) {
    console.log(`using existing staged binary: ${dest}`);
    process.exit(0);
  }
  const msg = `rbo-windows-executor.exe not found under native/windows-executor/target/{release,debug}/ and not staged at ${dest}. Build on Windows x64: cargo build --release --manifest-path native/windows-executor/Cargo.toml`;
  if (requireBinary) {
    console.error(`error: ${msg}`);
    process.exit(1);
  }
  console.warn(`warn: ${msg}`);
  console.warn('warn: package will pack without the binary; rbo doctor will warn at runtime.');
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
console.log(`copied ${source} -> ${dest}`);
