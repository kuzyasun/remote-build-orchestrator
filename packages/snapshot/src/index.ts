import { z } from 'zod';

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const ContentIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);

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
  main_mount: z.string().min(1),
  cwd: z.string().min(1),
});

export const SnapshotAdditionalRootSchema = z.object({
  id: z.string().min(1),
  mount: z.string().min(1),
  file_count: z.number().int().nonnegative(),
  total_size: z.number().int().nonnegative(),
  tree_sha256: Sha256HexSchema,
});

export const SnapshotRepoSchema = z.object({
  canonical_id: z.string().min(1),
  url: z.string().min(1),
  branch: z.string().nullable(),
  base_commit: z.string().min(1),
  head_is_pushed: z.boolean(),
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
