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
 *   - all workspace package.json files (apps/*, packages/*)
 *   - apps/cli/package.json (version + workspace optionalDependency pin)
 *   - pnpm-lock.yaml (workspace optionalDependency specifier)
 *   - native/windows-executor/Cargo.toml and Cargo.lock
 *   - packaging/{windows,macos,linux}/MANIFEST.json (package_version + components)
 *   - CHANGELOG.md (promotes ## [Unreleased] notes into ## [x.y.z] - YYYY-MM-DD)
 */
import { existsSync } from 'node:fs';
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
const CARGO_TOML = join(ROOT, 'native', 'windows-executor', 'Cargo.toml');
const CARGO_LOCK = join(ROOT, 'native', 'windows-executor', 'Cargo.lock');
const PACKAGING_DIR = join(ROOT, 'packaging');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const OPTIONAL_DEP = '@gemslibe/rbo-windows-executor-win32-x64';
const UNRELEASED_HEADER = '## [Unreleased]';

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

async function listAllPackageJsonPaths() {
  const dirs = ['apps', 'packages'];
  const paths = [ROOT_PKG];
  for (const dir of dirs) {
    const parent = join(ROOT, dir);
    if (!existsSync(parent)) continue;
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pkgPath = join(parent, entry.name, 'package.json');
        if (existsSync(pkgPath)) {
          paths.push(pkgPath);
        }
      }
    }
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

function extractCargoVersion(source) {
  const match = source.match(/name\s*=\s*"rbo-windows-executor"\s*\r?\nversion\s*=\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

function readCurrentVersions(versionsSource, packageFiles, lockSource, manifests, cargoSource) {
  const fromTs = CONST_NAMES.map((name) => extractConstVersion(versionsSource, name));
  const cliPkg = packageFiles.find((p) => p.path === CLI_PKG)?.data ?? {};
  const cliOptionalRaw = cliPkg.optionalDependencies?.[OPTIONAL_DEP] ?? null;
  return {
    versionsTs: fromTs,
    packages: packageFiles.map((p) => ({
      path: p.path,
      version: p.data.version ?? null,
    })),
    cliOptionalRaw,
    cliOptional: cliOptionalRaw?.replace(/^workspace:/, '') ?? null,
    lock: extractLockVersion(lockSource),
    cargo: cargoSource ? extractCargoVersion(cargoSource) : null,
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

  for (const pkg of current.packages) {
    if (pkg.version == null) {
      fail(`missing "version" in ${rel(pkg.path)}`);
    }
  }

  if (current.cliOptional == null) {
    fail(`missing optionalDependencies["${OPTIONAL_DEP}"] in ${rel(CLI_PKG)}`);
  }

  const cliVersion = current.packages.find((p) => p.path === CLI_PKG)?.version;
  if (current.cliOptionalRaw !== `workspace:${cliVersion}`) {
    fail(
      `optionalDependencies["${OPTIONAL_DEP}"] must equal "workspace:${cliVersion}" in ${rel(CLI_PKG)}`,
    );
  }

  if (current.lock == null) {
    fail(`missing workspace optionalDependency specifier in ${rel(PNPM_LOCK)}`);
  }

  if (current.cargo == null) {
    fail(`missing version in ${rel(CARGO_TOML)}`);
  }

  const all = [
    ...current.versionsTs,
    ...current.packages.map((p) => p.version),
    current.cliOptional,
    current.lock,
    current.cargo,
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

async function writeCargoTomlVersion(currentVersion, next) {
  let text = await readFile(CARGO_TOML, 'utf8');
  const versionRe = new RegExp(
    `(name\\s*=\\s*"rbo-windows-executor"\\s*\\r?\\nversion\\s*=\\s*")${escapeRegExp(currentVersion)}(")`,
  );
  if (!versionRe.test(text)) {
    fail(`could not find rbo-windows-executor version = "${currentVersion}" in ${rel(CARGO_TOML)}`);
  }
  text = text.replace(versionRe, `$1${next}$2`);
  await writeFile(CARGO_TOML, text, 'utf8');
  return rel(CARGO_TOML);
}

async function writeCargoLockVersion(currentVersion, next) {
  if (!existsSync(CARGO_LOCK)) return null;
  let text = await readFile(CARGO_LOCK, 'utf8');
  const blockRe = new RegExp(
    `(name\\s*=\\s*"rbo-windows-executor"\\s*\\r?\\nversion\\s*=\\s*")${escapeRegExp(currentVersion)}(")`,
  );
  if (blockRe.test(text)) {
    text = text.replace(blockRe, `$1${next}$2`);
    await writeFile(CARGO_LOCK, text, 'utf8');
    return rel(CARGO_LOCK);
  }
  return null;
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

function hasUnreleasedEntries(body) {
  return /^\s*[-*] /m.test(body);
}

function splitUnreleased(source) {
  const headerIdx = source.indexOf(UNRELEASED_HEADER);
  if (headerIdx === -1) {
    fail(`missing ${UNRELEASED_HEADER} in ${rel(CHANGELOG)}`);
  }
  if (headerIdx > 0 && source[headerIdx - 1] !== '\n') {
    fail(`${UNRELEASED_HEADER} must start on its own line in ${rel(CHANGELOG)}`);
  }

  const bodyStart = headerIdx + UNRELEASED_HEADER.length;
  const nextHeading = source.indexOf('\n## [', bodyStart);
  if (nextHeading === -1) {
    fail(`missing version section after Unreleased in ${rel(CHANGELOG)}`);
  }

  return {
    prefix: source.slice(0, headerIdx),
    body: source.slice(bodyStart, nextHeading),
    rest: source.slice(nextHeading + 1),
  };
}

function assertUnreleasedHasNotes(source) {
  const { body } = splitUnreleased(source);
  if (!hasUnreleasedEntries(body)) {
    fail(`${rel(CHANGELOG)} Unreleased has no list entries; add user-facing notes before bumping`);
  }
}

function updateChangelogLinks(source, currentVersion, next) {
  const unreleasedRe = new RegExp(
    `^(\\[Unreleased\\]: )(https://github\\.com/[^\\s]+)/compare/v${escapeRegExp(currentVersion)}(\\.\\.\\.HEAD)\\s*$`,
    'm',
  );
  const match = source.match(unreleasedRe);
  if (!match) {
    fail(`could not find [Unreleased] compare link for v${currentVersion} in ${rel(CHANGELOG)}`);
  }
  const repoUrl = match[2];
  const nextSource = source.replace(unreleasedRe, `$1${repoUrl}/compare/v${next}$3`);
  const marker = `[Unreleased]: ${repoUrl}/compare/v${next}...HEAD`;
  const markerIdx = nextSource.indexOf(marker);
  if (markerIdx === -1) {
    fail(`could not insert [${next}] release link in ${rel(CHANGELOG)}`);
  }
  const insertAt = markerIdx + marker.length;
  if (!nextSource.startsWith('\n', insertAt)) {
    fail(`could not insert [${next}] release link in ${rel(CHANGELOG)}`);
  }
  return `${nextSource.slice(0, insertAt)}\n[${next}]: ${repoUrl}/releases/tag/v${next}${nextSource.slice(insertAt)}`;
}

function extractPreviousChangelogVersion(rest) {
  const match = rest.match(/^## \[(\d+\.\d+\.\d+)\]/);
  if (!match) {
    fail(`could not read previous version heading in ${rel(CHANGELOG)}`);
  }
  return match[1];
}

function promoteUnreleased(source, currentVersion, next, isoDate) {
  assertUnreleasedHasNotes(source);
  const { prefix, body, rest } = splitUnreleased(source);
  const previous = extractPreviousChangelogVersion(rest);
  if (previous !== currentVersion) {
    fail(`${rel(CHANGELOG)} latest version section is ${previous}, expected ${currentVersion}`);
  }
  const notes = body.replace(/^\r?\n*/, '');
  const promoted = `${prefix}${UNRELEASED_HEADER}\n\n## [${next}] - ${isoDate}\n\n${notes}\n${rest}`;
  return updateChangelogLinks(promoted, currentVersion, next);
}

async function writeChangelog(contents) {
  await writeFile(CHANGELOG, contents, 'utf8');
  return rel(CHANGELOG);
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
  const [manifestPaths, packagePaths] = await Promise.all([
    listManifestPaths(),
    listAllPackageJsonPaths(),
  ]);

  const [versionsSource, lockSource, cargoSource, ...allFiles] = await Promise.all([
    readFile(VERSIONS_TS, 'utf8'),
    readFile(PNPM_LOCK, 'utf8'),
    existsSync(CARGO_TOML) ? readFile(CARGO_TOML, 'utf8') : Promise.resolve(null),
    ...packagePaths.map(async (path) => ({ type: 'pkg', path, data: await readJson(path) })),
    ...manifestPaths.map(async (path) => ({ type: 'manifest', path, data: await readJson(path) })),
  ]);

  const packageFiles = allFiles.filter((f) => f.type === 'pkg');
  const manifestFiles = allFiles.filter((f) => f.type === 'manifest');

  const current = readCurrentVersions(
    versionsSource,
    packageFiles,
    lockSource,
    manifestFiles,
    cargoSource,
  );
  const currentVersion = assertConsistent(current);
  const changelogSource = await readFile(CHANGELOG, 'utf8');
  assertUnreleasedHasNotes(changelogSource);

  console.log(`Current product version: ${currentVersion}`);

  const next = await askVersion(currentVersion);
  if (next === currentVersion) {
    console.log(`No change: already at ${currentVersion}`);
    return;
  }

  const changelogNext = promoteUnreleased(
    changelogSource,
    currentVersion,
    next,
    new Date().toISOString().slice(0, 10),
  );

  const changed = [];
  changed.push(await writeVersionsTs(next));
  for (const pkg of packageFiles) {
    changed.push(
      await writePackageVersion(pkg.path, currentVersion, next, {
        optionalDep: pkg.path === CLI_PKG,
      }),
    );
  }
  changed.push(await writeLockfileVersion(currentVersion, next));
  if (cargoSource) {
    changed.push(await writeCargoTomlVersion(currentVersion, next));
    const lockChanged = await writeCargoLockVersion(currentVersion, next);
    if (lockChanged) changed.push(lockChanged);
  }
  for (const path of manifestPaths) {
    changed.push(await writeManifestVersions(path, currentVersion, next));
  }
  changed.push(await writeChangelog(changelogNext));

  console.log(`Bumped ${currentVersion} → ${next}`);
  console.log('Updated:');
  for (const file of changed) {
    if (file === rel(VERSIONS_TS)) {
      console.log(`  - ${file} (${CONST_NAMES.join(', ')})`);
    } else if (file === rel(CLI_PKG)) {
      console.log(`  - ${file} (version, workspace optionalDependencies["${OPTIONAL_DEP}"])`);
    } else if (file === rel(PNPM_LOCK)) {
      console.log(`  - ${file} (workspace optionalDependency specifier)`);
    } else if (file === rel(CARGO_TOML)) {
      console.log(`  - ${file} (version)`);
    } else if (file === rel(CARGO_LOCK)) {
      console.log(`  - ${file} (rbo-windows-executor version)`);
    } else if (file.startsWith('packaging/')) {
      console.log(`  - ${file} (package_version, components)`);
    } else if (file === rel(CHANGELOG)) {
      console.log(`  - ${file} (Unreleased → ${next})`);
    } else {
      console.log(`  - ${file} (version)`);
    }
  }
}

await main();
