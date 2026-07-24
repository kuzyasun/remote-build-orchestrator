/**
 * Phase 8 packaging helpers: manifest validation and forbidden-path checks.
 * Archives must never include identity keys, credentials, caches, logs, or snapshots.
 */

import {
  RBO_AGENT_VERSION,
  RBO_CONTROLLER_VERSION,
  RBO_STDIO_ADAPTER_VERSION,
  RBO_WIRE_PROTOCOL_MAX_VERSION,
  RBO_WIRE_PROTOCOL_MIN_VERSION,
} from '@rbo/shared';

export const PACKAGING_FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)identity\//i,
  /device[_-]private/i,
  /signing[_-]private/i,
  /agent[_-]credential/i,
  /(^|\/)caches?\//i,
  /(^|\/)logs?\//i,
  /(^|\/)snapshots?\//i,
  /(^|\/)attempts\//i,
  /(^|\/)node_modules\//i,
  /\.pem$/i,
  /\.key$/i,
];

export interface PackagingFileEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface PackagingManifest {
  schema_version: 1;
  os: 'windows' | 'macos' | 'linux';
  package_version: string;
  wire_protocol: { min: number; max: number };
  components: {
    controller: string;
    agent: string;
    cli: string;
    mcp_stdio: string;
    windows_executor?: string;
  };
  files: PackagingFileEntry[];
  forbidden_path_patterns: string[];
}

export function isForbiddenPackagingPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return PACKAGING_FORBIDDEN_PATH_PATTERNS.some((re) => re.test(normalized));
}

export function verifyArchiveManifest(manifest: PackagingManifest): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const required = ['controller', 'agent', 'cli', 'mcp_stdio'] as const;
  for (const key of required) {
    if (!manifest.components[key]) {
      errors.push(`missing component ${key}`);
    }
  }
  if (manifest.os === 'windows' && !manifest.components.windows_executor) {
    errors.push('windows package must list windows_executor');
  }
  if (manifest.wire_protocol.min !== RBO_WIRE_PROTOCOL_MIN_VERSION) {
    errors.push('wire min mismatch');
  }
  if (manifest.wire_protocol.max !== RBO_WIRE_PROTOCOL_MAX_VERSION) {
    errors.push('wire max mismatch');
  }
  for (const file of manifest.files) {
    if (isForbiddenPackagingPath(file.path)) {
      errors.push(`forbidden path: ${file.path}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(file.sha256)) {
      errors.push(`bad sha256 for ${file.path}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function buildBaseManifest(os: PackagingManifest['os']): PackagingManifest {
  return {
    schema_version: 1,
    os,
    package_version: RBO_CONTROLLER_VERSION,
    wire_protocol: {
      min: RBO_WIRE_PROTOCOL_MIN_VERSION,
      max: RBO_WIRE_PROTOCOL_MAX_VERSION,
    },
    components: {
      controller: RBO_CONTROLLER_VERSION,
      agent: RBO_AGENT_VERSION,
      cli: RBO_CONTROLLER_VERSION,
      mcp_stdio: RBO_STDIO_ADAPTER_VERSION,
      ...(os === 'windows' ? { windows_executor: RBO_CONTROLLER_VERSION } : {}),
    },
    files: [],
    forbidden_path_patterns: PACKAGING_FORBIDDEN_PATH_PATTERNS.map(String),
  };
}
