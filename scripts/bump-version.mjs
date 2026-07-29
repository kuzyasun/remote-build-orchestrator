#!/usr/bin/env node
/**
 * Bump the single product semver across all lockstep release sites.
 * Usage:
 *   pnpm bump-version              # interactive prompt
 *   pnpm bump-version 1.2.3        # non-interactive
 *   echo 1.2.3 | pnpm bump-version # piped non-interactive
 *
 * Sites (see docs/dev/release-builds.md — Detailed steps → Bump version):
 *   - packages/shared/src/versions.ts (three runtime constants)
 *   - root package.json
 *   - apps/cli/package.json (version + workspace optionalDependency pin)
 *   - pnpm-lock.yaml (workspace optionalDependency specifier)
 *   - packages/rbo-windows-executor-win32-x64/package.json
 *   - packaging/{windows,macos,linux}/MANIFEST.json (package_version + components)
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const VERSIONS_TS = join(ROOT, 'packages', 'shared', 'src', 'versions.ts');
const ROOT_PKG = join(ROOT, 'package.json');
const CLI_PKG = join(ROOT, 'apps', 'cli', 'package.json');
const PNPM_LOCK = join(ROOT, 'pnpm-lock.yaml');
const EXECUTOR_PKG = join(ROOT, 'packages', 'rbo-windows-executor-win32-x64', 'package.json');
const PACKAGING_DIR = join(ROOT, 'packaging');
const OPTIONAL_DEP = '@gemslibe/rbo-windows-executor-win32-x64';

const CONST_NAMES = ['RBO_CONTROLLER_VERSION', 'RBO_AGENT_VERSION', 'RBO_STDIO_ADAPTER_VERSION'];

function rel(abs) {
  return relative(ROOT, abs).split('\\').join('/');
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseSemver(raw) {
  const version = String(raw ?? '').trim();
  if (!SEMVER_RE.test(version)) {
    return null;
  }
  return version;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function extractConstVersion(source, name) {
  const match = source.match(new RegExp(`export const ${name} = '([^']+)';`));
  return match?.[1] ?? null;
}

async function listManifestPaths() {
  const entries = await readdir(PACKAGING_DIR, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(join(PACKAGING_DIR, entry.name, 'MANIFEST.json'));
  }
  return paths.sort();
}

function extractLockVersion(source) {
  const dependency = escapeRegExp(OPTIONAL_DEP);
  const match = source.match(
    new RegExp(`'${dependency}':\\r?\\n\\s+specifier: workspace:([^\\r\\n]+)`),
  );
  return match?.[1]?.trim() ?? null;
}

function readCurrentVersions(versionsSource, rootPkg, cliPkg, executorPkg, lockSource, manifests) {
  const fromTs = CONST_NAMES.map((name) => extractConstVersion(versionsSource, name));
  const cliOptionalRaw = cliPkg.optionalDependencies?.[OPTIONAL_DEP] ?? null;
  return {
    versionsTs: fromTs,
    root: rootPkg.version ?? null,
    cli: cliPkg.version ?? null,
    cliOptionalRaw,
    cliOptional: cliOptionalRaw?.replace(/^workspace:/, '') ?? null,
    lock: extractLockVersion(lockSource),
    executor: executorPkg.version ?? null,
    manifests: manifests.map((m) => ({
      path: m.path,
      package_version: m.data.package_version ?? null,
      components: m.data.components ?? {},
    })),
  };
}

function uniqueNonNull(values) {
  return [...new Set(values.filter((v) => v != null))];
}

function assertConsistent(current) {
  for (let i = 0; i < CONST_NAMES.length; i += 1) {
    if (current.versionsTs[i] == null) {
      fail(`missing ${CONST_NAMES[i]} in ${rel(VERSIONS_TS)}`);
    }
  }
  if (current.root == null) fail(`missing "version" in ${rel(ROOT_PKG)}`);
  if (current.cli == null) fail(`missing "version" in ${rel(CLI_PKG)}`);
  if (current.cliOptional == null) {
    fail(`missing optionalDependencies["${OPTIONAL_DEP}"] in ${rel(CLI_PKG)}`);
  }
  if (current.cliOptionalRaw !== `workspace:${current.cli}`) {
    fail(
      `optionalDependencies["${OPTIONAL_DEP}"] must equal "workspace:${current.cli}" in ${rel(CLI_PKG)}`,
    );
  }
  if (current.executor == null) fail(`missing "version" in ${rel(EXECUTOR_PKG)}`);
  if (current.lock == null) {
    fail(`missing workspace optionalDependency specifier in ${rel(PNPM_LOCK)}`);
  }

  const all = [
    ...current.versionsTs,
    current.root,
    current.cli,
    current.cliOptional,
    current.lock,
    current.executor,
  ];

  for (const manifest of current.manifests) {
    if (manifest.package_version == null) {
      fail(`missing package_version in ${rel(manifest.path)}`);
    }
    all.push(manifest.package_version);
    for (const [key, value] of Object.entries(manifest.components)) {
      if (value == null) {
        fail(`missing components.${key} in ${rel(manifest.path)}`);
      }
      all.push(value);
    }
  }

  const unique = uniqueNonNull(all);
  if (unique.length > 1) {
    fail(
      `product versions are already mismatched (${unique.join(', ')}); fix by hand before bumping`,
    );
  }
  return unique[0];
}

async function askVersion(current) {
  const argvVersion = process.argv[2];
  if (argvVersion !== undefined) {
    const parsed = parseSemver(argvVersion);
    if (!parsed) {
      fail(`invalid semver '${argvVersion}' (expected x.y.z, e.g. 1.2.3)`);
    }
    return parsed;
  }

  if (!input.isTTY) {
    // Piped stdin (e.g. echo 1.2.3 | pnpm bump-version)
    const chunks = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    const parsed = parseSemver(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '');
    if (!parsed) {
      fail('invalid or empty semver on stdin (expected x.y.z, e.g. 1.2.3)');
    }
    return parsed;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`New version (current ${current}): `);
    const parsed = parseSemver(answer);
    if (!parsed) {
      fail(`invalid semver '${answer.trim()}' (expected x.y.z, e.g. 1.2.3)`);
    }
    return parsed;
  } finally {
    rl.close();
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeVersionsTs(next) {
  let source = await readFile(VERSIONS_TS, 'utf8');
  for (const name of CONST_NAMES) {
    const re = new RegExp(`(export const ${name} = ')[^']+(';)`);
    if (!re.test(source)) {
      fail(`could not update ${name} in ${rel(VERSIONS_TS)}`);
    }
    source = source.replace(re, `$1${next}$2`);
  }
  await writeFile(VERSIONS_TS, source, 'utf8');
  return rel(VERSIONS_TS);
}

/** Replace only product-version fields; preserve surrounding package.json formatting. */
async function writePackageVersion(path, currentVersion, next, { optionalDep } = {}) {
  let text = await readFile(path, 'utf8');
  const versionRe = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(currentVersion)}(")`);
  if (!versionRe.test(text)) {
    fail(`could not find "version": "${currentVersion}" in ${rel(path)}`);
  }
  text = text.replace(versionRe, `$1${next}$2`);

  if (optionalDep) {
    const optRe = new RegExp(
      `("${escapeRegExp(OPTIONAL_DEP)}"\\s*:\\s*"workspace:)${escapeRegExp(currentVersion)}(")`,
    );
    if (!optRe.test(text)) {
      fail(
        `could not find optionalDependencies["${OPTIONAL_DEP}"] = "workspace:${currentVersion}" in ${rel(path)}`,
      );
    }
    text = text.replace(optRe, `$1${next}$2`);
  }

  await writeFile(path, text, 'utf8');
  return rel(path);
}

async function writeLockfileVersion(currentVersion, next) {
  let text = await readFile(PNPM_LOCK, 'utf8');
  const dependency = escapeRegExp(OPTIONAL_DEP);
  const specifierRe = new RegExp(
    `('${dependency}':\\r?\\n\\s+specifier: workspace:)${escapeRegExp(currentVersion)}(\\r?\\n)`,
  );
  if (!specifierRe.test(text)) {
    fail(
      `could not find ${OPTIONAL_DEP} workspace specifier ${currentVersion} in ${rel(PNPM_LOCK)}`,
    );
  }
  text = text.replace(specifierRe, `$1${next}$2`);
  await writeFile(PNPM_LOCK, text, 'utf8');
  return rel(PNPM_LOCK);
}

/** Update package_version and every components.* string that matches currentVersion. */
async function writeManifestVersions(path, currentVersion, next) {
  let text = await readFile(path, 'utf8');
  const packageRe = new RegExp(`("package_version"\\s*:\\s*")${escapeRegExp(currentVersion)}(")`);
  if (!packageRe.test(text)) {
    fail(`could not find "package_version": "${currentVersion}" in ${rel(path)}`);
  }
  text = text.replace(packageRe, `$1${next}$2`);

  // Replace component version values that still match the previous product version.
  text = text.replace(new RegExp(`(:\\s*")${escapeRegExp(currentVersion)}(")`, 'g'), `$1${next}$2`);

  await writeFile(path, text, 'utf8');
  return rel(path);
}

async function main() {
  const manifestPaths = await listManifestPaths();
  const [versionsSource, rootPkg, cliPkg, executorPkg, lockSource, ...manifestFiles] =
    await Promise.all([
      readFile(VERSIONS_TS, 'utf8'),
      readJson(ROOT_PKG),
      readJson(CLI_PKG),
      readJson(EXECUTOR_PKG),
      readFile(PNPM_LOCK, 'utf8'),
      ...manifestPaths.map(async (path) => ({ path, data: await readJson(path) })),
    ]);

  const current = readCurrentVersions(
    versionsSource,
    rootPkg,
    cliPkg,
    executorPkg,
    lockSource,
    manifestFiles,
  );
  const currentVersion = assertConsistent(current);

  console.log(`Current product version: ${currentVersion}`);

  const next = await askVersion(currentVersion);
  if (next === currentVersion) {
    console.log(`No change: already at ${currentVersion}`);
    return;
  }

  const changed = [];
  changed.push(await writeVersionsTs(next));
  changed.push(await writePackageVersion(ROOT_PKG, currentVersion, next));
  changed.push(await writePackageVersion(CLI_PKG, currentVersion, next, { optionalDep: true }));
  changed.push(await writeLockfileVersion(currentVersion, next));
  changed.push(await writePackageVersion(EXECUTOR_PKG, currentVersion, next));
  for (const path of manifestPaths) {
    changed.push(await writeManifestVersions(path, currentVersion, next));
  }

  console.log(`Bumped ${currentVersion} → ${next}`);
  console.log('Updated:');
  for (const file of changed) {
    if (file === rel(VERSIONS_TS)) {
      console.log(`  - ${file} (${CONST_NAMES.join(', ')})`);
    } else if (file === rel(CLI_PKG)) {
      console.log(`  - ${file} (version, workspace optionalDependencies["${OPTIONAL_DEP}"])`);
    } else if (file === rel(PNPM_LOCK)) {
      console.log(`  - ${file} (workspace optionalDependency specifier)`);
    } else if (file.startsWith('packaging/')) {
      console.log(`  - ${file} (package_version, components)`);
    } else {
      console.log(`  - ${file} (version)`);
    }
  }
}

await main();
