import { ensureControllerIdentity } from '@rbo/shared';

export interface ControllerInitOptions {
  dataDir: string;
}

export interface ControllerIdentitySummary {
  controllerId: string;
  fingerprint: string;
}

// `rbo controller init` (§33, Phase 2): generate the pinned TLS certificate
// and signing keys once; safe to re-run — it reuses the existing identity.
export async function runControllerInit(
  options: ControllerInitOptions,
): Promise<ControllerIdentitySummary> {
  const identity = await ensureControllerIdentity(options.dataDir);
  return { controllerId: identity.controllerId, fingerprint: identity.fingerprint };
}

// `rbo controller fingerprint`: display the fingerprint out-of-band so the
// operator can compare it on the Agent side before approving pairing.
export async function runControllerFingerprint(
  options: ControllerInitOptions,
): Promise<ControllerIdentitySummary> {
  const identity = await ensureControllerIdentity(options.dataDir);
  return { controllerId: identity.controllerId, fingerprint: identity.fingerprint };
}
