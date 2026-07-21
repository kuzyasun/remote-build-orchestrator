import { RBO_WIRE_PROTOCOL_MAX_VERSION, RBO_WIRE_PROTOCOL_MIN_VERSION } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_DEFS } from '../src/mcp-tools.js';
import { negotiateProtocolVersion } from '../src/versions.js';

/** Phase 8 frozen MCP tool set — do not extend without updating this fixture. */
const PHASE8_FROZEN_TOOL_NAMES = [
  'agents_list',
  'job_submit',
  'job_confirm',
  'job_get',
  'job_wait',
  'job_logs',
  'job_cancel',
  'job_artifacts',
  'artifact_materialize',
  'agent_probe',
] as const;

describe('Protocol freeze', () => {
  it('freezes MCP tool names to the Phase 8 set', () => {
    expect(MCP_TOOL_DEFS.map((d) => d.name).sort()).toEqual([...PHASE8_FROZEN_TOOL_NAMES].sort());
  });

  it('freezes wire protocol range to min=max=1', () => {
    expect(RBO_WIRE_PROTOCOL_MIN_VERSION).toBe(1);
    expect(RBO_WIRE_PROTOCOL_MAX_VERSION).toBe(1);
  });

  it('rejects incompatible peers without a negotiated version', () => {
    expect(negotiateProtocolVersion({ min_version: 2, max_version: 2 })).toBeNull();
  });

  it('negotiates version 1 for a compatible peer', () => {
    expect(negotiateProtocolVersion({ min_version: 1, max_version: 1 })).toBe(1);
  });
});
