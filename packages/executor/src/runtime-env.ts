/**
 * Canonical reserved RBO runtime environment keys (§13.4).
 * Injected values always win over user `execution.env` RBO_* keys.
 * Artifact path key is singular `RBO_ARTIFACT_DIR` — no plural alias.
 */
export const CANONICAL_RBO_ENV_KEYS = [
  'RBO_JOB_ID',
  'RBO_ATTEMPT_ID',
  'RBO_WORKSPACE',
  'RBO_PROJECT_DIR',
  'RBO_LOG_DIR',
  'RBO_ARTIFACT_DIR',
] as const;

export type CanonicalRboEnvKey = (typeof CANONICAL_RBO_ENV_KEYS)[number];

export function buildReservedRboEnv(input: {
  jobId: string;
  attemptId: string;
  workspacePath: string;
  projectPath: string;
  logDir: string;
  artifactDir: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (!key.startsWith('RBO_')) {
      extra[key] = value;
    }
  }
  return {
    ...extra,
    RBO_JOB_ID: input.jobId,
    RBO_ATTEMPT_ID: input.attemptId,
    RBO_WORKSPACE: input.workspacePath,
    RBO_PROJECT_DIR: input.projectPath,
    RBO_LOG_DIR: input.logDir,
    RBO_ARTIFACT_DIR: input.artifactDir,
  };
}
