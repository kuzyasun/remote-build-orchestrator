import { sha256 } from '@rbo/shared';
import type { FullSnapshotManifest, SnapshotFileEntry } from './index.js';

/** Stable JSON serialization for deterministic content_id (§11.16). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

export function computeContentId(
  manifestBody: Omit<FullSnapshotManifest, 'content_id'>,
  orderedFileHashes: string[],
): string {
  const canonical = stableStringify(manifestBody);
  const hashInput = `${canonical}\n${orderedFileHashes.join('\n')}`;
  return `sha256:${sha256(hashInput)}`;
}

export function attachContentId(
  manifestBody: Omit<FullSnapshotManifest, 'content_id'>,
): FullSnapshotManifest {
  const fileHashes = collectOrderedFileHashes(manifestBody);
  const content_id = computeContentId(manifestBody, fileHashes);
  return { ...manifestBody, content_id };
}

function collectOrderedFileHashes(manifest: Omit<FullSnapshotManifest, 'content_id'>): string[] {
  const hashes = manifest.source.files
    .filter((entry): entry is Extract<SnapshotFileEntry, { type: 'file' }> => entry.type === 'file')
    .map((entry) => entry.sha256)
    .sort();
  return hashes;
}
