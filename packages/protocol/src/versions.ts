import { RBO_WIRE_PROTOCOL_MAX_VERSION, RBO_WIRE_PROTOCOL_MIN_VERSION } from '@rbo/shared';

export interface VersionHandshake {
  min_version: number;
  max_version: number;
}

export function negotiateProtocolVersion(agent: VersionHandshake): number | null {
  const min = Math.max(RBO_WIRE_PROTOCOL_MIN_VERSION, agent.min_version);
  const max = Math.min(RBO_WIRE_PROTOCOL_MAX_VERSION, agent.max_version);
  if (min <= max) {
    return max;
  }
  return null;
}
