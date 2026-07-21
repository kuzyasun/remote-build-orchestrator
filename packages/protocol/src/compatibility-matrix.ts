import { z } from 'zod';

/** Machine-readable AI-client compatibility cell (§24.1 / Phase 8). */
export const CompatibilityCellSchema = z.object({
  client: z.string().min(1),
  transport: z.enum(['stdio', 'streamable_http']),
  status: z.enum(['verified', 'not_verified']),
  revision: z.string().min(1),
  os: z.string().min(1),
  client_version: z.string().min(1),
  config_ref: z.string().min(1),
  workflow: z.string().min(1),
  limitation: z.string().optional(),
  evidence_path: z.string().optional(),
});

export const CompatibilityMatrixSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().min(1),
  policy: z.string().min(1),
  cells: z.array(CompatibilityCellSchema).min(1),
});

export type CompatibilityCell = z.infer<typeof CompatibilityCellSchema>;
export type CompatibilityMatrix = z.infer<typeof CompatibilityMatrixSchema>;
