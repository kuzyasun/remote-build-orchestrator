import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Device identity and optional controller-issued credential. Never log this object. */
export interface StoredAgentState {
  devicePublicKeyPem: string;
  devicePrivateKeyPem: string;
  credential?: string;
  agentId?: string;
}

export function agentStatePath(stateDir: string): string {
  return join(stateDir, 'agent-state.json');
}

export function readStoredAgentState(stateDir: string): StoredAgentState | null {
  const path = agentStatePath(stateDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredAgentState>;
    if (
      typeof parsed.devicePublicKeyPem !== 'string' ||
      typeof parsed.devicePrivateKeyPem !== 'string'
    ) {
      return null;
    }
    return {
      devicePublicKeyPem: parsed.devicePublicKeyPem,
      devicePrivateKeyPem: parsed.devicePrivateKeyPem,
      ...(typeof parsed.credential === 'string' && parsed.credential.length > 0
        ? { credential: parsed.credential }
        : {}),
      ...(typeof parsed.agentId === 'string' && parsed.agentId.length > 0
        ? { agentId: parsed.agentId }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeStoredAgentState(stateDir: string, state: StoredAgentState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(agentStatePath(stateDir), JSON.stringify(state), { mode: 0o600 });
}

/**
 * Drop the controller credential and agent id, keeping the device key.
 * Used when init points at a different controller, or when that controller
 * rejects the stored credential so the agent can send a new pairing request.
 * @returns true when a credential or agent id was removed.
 */
export function clearStoredAgentCredential(stateDir: string): boolean {
  const state = readStoredAgentState(stateDir);
  if (!state?.credential && !state?.agentId) {
    return false;
  }
  writeStoredAgentState(stateDir, {
    devicePublicKeyPem: state.devicePublicKeyPem,
    devicePrivateKeyPem: state.devicePrivateKeyPem,
  });
  return true;
}

export function controllerTargetChanged(
  previous: { controllerUrl?: string; fingerprint?: string },
  next: { controllerUrl?: string; fingerprint?: string },
): boolean {
  const prevUrl = previous.controllerUrl?.trim() ?? '';
  const nextUrl = next.controllerUrl?.trim() ?? '';
  const prevFp = previous.fingerprint?.trim() ?? '';
  const nextFp = next.fingerprint?.trim() ?? '';
  if (!prevUrl && !prevFp) {
    return false;
  }
  return prevUrl !== nextUrl || prevFp !== nextFp;
}
