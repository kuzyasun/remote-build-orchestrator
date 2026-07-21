import { isSafeRelativePath } from '@rbo/shared';
import { z } from 'zod';

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const ContentIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => isSafeRelativePath(value), {
    message: "must be a relative path without '..', absolute, or UNC segments",
  });

// --- File entries (§11.6, §11.7) ---

export const SnapshotFileEntrySchema = z.discriminatedUnion('type', [
  z.object({
    path: z.string().min(1),
    type: z.literal('file'),
    mode: z.enum(['100644', '100755']),
    size: z.number().int().nonnegative(),
    sha256: Sha256HexSchema,
  }),
  z.object({
    path: z.string().min(1),
    type: z.literal('symlink'),
    mode: z.literal('120000'),
    target: z.string().min(1),
  }),
]);

export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>;

// --- Shared manifest blocks (§11.4) ---

export const SnapshotWorkspaceSchema = z.object({
  main_mount: SafeRelativePathSchema,
  cwd: z
    .string()
    .min(1)
    .refine((value) => isSafeRelativePath(value, { allowDot: true }), {
      message: "must be a relative path without '..', absolute, or UNC segments",
    }),
});

export const SnapshotAdditionalRootSchema = z.object({
  id: z.string().min(1),
  mount: SafeRelativePathSchema,
  file_count: z.number().int().nonnegative(),
  total_size: z.number().int().nonnegative(),
  tree_sha256: Sha256HexSchema,
  mode: z.enum(['read_only', 'read_write']).default('read_only'),
});

export const SnapshotRepoSchema = z.object({
  canonical_id: z.string().min(1),
  url: z.string().min(1),
  branch: z.string().nullable(),
  base_commit: z.string().min(1),
  head_is_pushed: z.boolean(),
  /** Optional; Controller derives from branch when absent (§10.6). */
  fetch_refs: z.array(z.string().min(1)).optional(),
});

const payloadBase = {
  format: z.literal('tar'),
  compression: z.literal('zstd'),
  sha256: Sha256HexSchema,
  size: z.number().int().nonnegative(),
};

// --- Manifest: discriminated by payload.mode (§12.1) ---
// `full` MUST have source.files and MUST NOT require repo.base_commit or overlay;
// `git_overlay` MUST have repo.base_commit, overlay.files and overlay.deletions.

export const FullSnapshotManifestSchema = z
  .object({
    schema_version: z.literal(1),
    content_id: ContentIdSchema,
    repo: SnapshotRepoSchema.partial({ base_commit: true }).optional(),
    workspace: SnapshotWorkspaceSchema,
    source: z.object({
      files: z.array(SnapshotFileEntrySchema),
      empty_directories: z.array(z.string()).default([]),
    }),
    additional_roots: z.array(SnapshotAdditionalRootSchema).default([]),
    payload: z.object({ mode: z.literal('full'), ...payloadBase }),
  })
  .strict();

export const GitOverlaySnapshotManifestSchema = z
  .object({
    schema_version: z.literal(1),
    content_id: ContentIdSchema,
    repo: SnapshotRepoSchema,
    workspace: SnapshotWorkspaceSchema,
    overlay: z.object({
      files: z.array(SnapshotFileEntrySchema),
      deletions: z.array(z.string()),
      empty_directories: z.array(z.string()).default([]),
    }),
    additional_roots: z.array(SnapshotAdditionalRootSchema).default([]),
    payload: z.object({ mode: z.literal('git_overlay'), ...payloadBase }),
  })
  .strict();

export const SnapshotManifestSchema = z.union([
  FullSnapshotManifestSchema,
  GitOverlaySnapshotManifestSchema,
]);

export type FullSnapshotManifest = z.infer<typeof FullSnapshotManifestSchema>;
export type GitOverlaySnapshotManifest = z.infer<typeof GitOverlaySnapshotManifestSchema>;
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

// --- Snapshot instance (§11.16) ---
// snapshot_id and capture time are runtime metadata of one concrete capture and
// stay outside the canonical content manifest so content_id remains deterministic.

export const SnapshotInstanceSchema = z.object({
  snapshot_id: z.string().min(1),
  content_id: ContentIdSchema,
  captured_at: z.string().min(1),
});

export type SnapshotInstance = z.infer<typeof SnapshotInstanceSchema>;

export * from './git-status.js';
export * from './git-source-policy.js';
export * from './secret-policy.js';
export * from './archive.js';
export * from './canonical.js';
export * from './capture.js';
export * from './overlay.js';
export * from './materialize.js';
