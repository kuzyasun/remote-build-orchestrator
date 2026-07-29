import { sha256 } from '@rbo/shared';
import type {
  FullSnapshotManifest,
  GitOverlaySnapshotManifest,
  SnapshotFileEntry,
  SnapshotManifest,
} from './index.js';

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

type ManifestBody = Omit<SnapshotManifest, 'content_id'>;

export function computeContentId(manifestBody: ManifestBody, orderedFileHashes: string[]): string {
  const canonical = stableStringify(manifestBody);
  const hashInput = `${canonical}\n${orderedFileHashes.join('\n')}`;
  return `sha256:${sha256(hashInput)}`;
}

export function attachContentId(
  manifestBody: Omit<FullSnapshotManifest, 'content_id'>,
): FullSnapshotManifest;
export function attachContentId(
  manifestBody: Omit<GitOverlaySnapshotManifest, 'content_id'>,
): GitOverlaySnapshotManifest;
export function attachContentId(manifestBody: ManifestBody): SnapshotManifest {
  const fileHashes = collectOrderedFileHashes(manifestBody);
  const content_id = computeContentId(manifestBody, fileHashes);
  return { ...manifestBody, content_id } as SnapshotManifest;
}

function collectOrderedFileHashes(manifest: ManifestBody): string[] {
  let files: SnapshotFileEntry[] = [];
  if (manifest.payload.mode === 'full') {
    files = (manifest as Omit<FullSnapshotManifest, 'content_id'>).source.files;
  } else if (manifest.payload.mode === 'git_overlay') {
    files = (manifest as Omit<GitOverlaySnapshotManifest, 'content_id'>).overlay.files;
  }
  return files
    .filter((entry): entry is Extract<SnapshotFileEntry, { type: 'file' }> => entry.type === 'file')
    .map((entry) => entry.sha256)
    .sort();
}
