#!/usr/bin/env node
/**
 * Build/verify Phase 8 packaging manifests.
 * Usage:
 *   node scripts/package-archives.mjs          # refresh checksums from sources if present
 *   node scripts/package-archives.mjs --verify # validate manifests only
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OSES = ['windows', 'macos', 'linux'];

// Single source of truth for the forbidden-path list lives in @rbo/shared
// (packages/shared/src/packaging.ts); import the built dist output directly rather than
// depending on the workspace package graph, so this plain script needs only `pnpm build` first.
const { isForbiddenPackagingPath } = await import(
  pathToFileURL(join(ROOT, 'packages', 'shared', 'dist', 'index.js')).href
);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isForbidden(p) {
  return isForbiddenPackagingPath(p);
}

/** MSVC cargo --release output is not bit-reproducible (PE timestamps and size). */
function isNonReproducibleNativeBinary(file) {
  const source = (file.source ?? '').replace(/\\/g, '/');
  return source.includes('native/windows-executor/target/');
}

async function refreshManifest(os) {
  const manifestPath = join(ROOT, 'packaging', os, 'MANIFEST.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const errors = [];

  if (!manifest.components?.controller || !manifest.components?.agent) {
    errors.push(`${os}: missing required components`);
  }
  if (os === 'windows' && !manifest.components.windows_executor) {
    errors.push(`${os}: missing windows_executor`);
  }

  for (const file of manifest.files ?? []) {
    if (isForbidden(file.path) || (file.source && isForbidden(file.source))) {
      errors.push(`${os}: forbidden path ${file.path}`);
      continue;
    }
    const sourceAbs = file.source ? join(ROOT, file.source) : null;
    if (sourceAbs && existsSync(sourceAbs)) {
      if (isNonReproducibleNativeBinary(file)) {
        continue;
      }
      const buf = await readFile(sourceAbs);
      file.sha256 = sha256(buf);
      file.size_bytes = buf.length;
    }
  }

  if (errors.length) {
    throw new Error(errors.join('\n'));
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function verifyOnly(os) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'packaging', os, 'MANIFEST.json'), 'utf8'));
  const errors = [];
  for (const file of manifest.files ?? []) {
    if (isForbidden(file.path) || (file.source && isForbidden(file.source))) {
      errors.push(`forbidden: ${file.path}`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')) {
      errors.push(`bad hash shape: ${file.path}`);
      continue;
    }
    // Real integrity check: recompute from the built source and compare, so a stale/placeholder
    // manifest fails loudly instead of only passing a format-shape regex.
    const sourceAbs = file.source ? join(ROOT, file.source) : null;
    if (!sourceAbs || !existsSync(sourceAbs)) {
      errors.push(
        `${file.path}: source not built (${file.source ?? 'no source recorded'}); run \`pnpm package:archives\` after \`pnpm build\``,
      );
      continue;
    }
    const buf = await readFile(sourceAbs);
    if (isNonReproducibleNativeBinary(file)) {
      continue;
    }
    const actualHash = sha256(buf);
    if (actualHash !== file.sha256) {
      errors.push(
        `${file.path}: sha256 mismatch (manifest=${file.sha256} actual=${actualHash}) — manifest is stale, run \`pnpm package:archives\``,
      );
    }
    if (buf.length !== file.size_bytes) {
      errors.push(
        `${file.path}: size_bytes mismatch (manifest=${file.size_bytes} actual=${buf.length})`,
      );
    }
  }
  if (os === 'windows' && !manifest.components?.windows_executor) {
    errors.push('windows_executor required');
  }
  if (errors.length) throw new Error(`${os}:\n${errors.join('\n')}`);
  console.log(
    `OK ${os} (${manifest.files.length} files, checksums verified against built sources)`,
  );
}

async function main() {
  const verify = process.argv.includes('--verify');
  for (const os of OSES) {
    if (verify) {
      await verifyOnly(os);
    } else {
      const m = await refreshManifest(os);
      console.log(`refreshed ${os}: ${m.files.length} files`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
