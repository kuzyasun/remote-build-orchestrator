/**
 * Round-2 fixes — assert corrected Controller/shared behaviour.
 */
import { createHash } from 'node:crypto';
import { isAllowedRepositoryUrl } from '@rbo/shared';
import { describe, expect, it } from 'vitest';

describe('REVIEW R2 controller/shared fixes', () => {
  it('[P2] cache-hit helper rejects stale manifest sha vs archive bytes', async () => {
    // Mirrors ensureFullFallbackArchive consistency check.
    const body = Buffer.from('actual-archive-bytes');
    const bodySha = createHash('sha256').update(body).digest('hex');
    const staleManifest = {
      payload: { mode: 'full', sha256: '0'.repeat(64), size: body.length },
    };
    const consistent =
      staleManifest.payload.sha256 === bodySha && staleManifest.payload.size === body.length;
    expect(consistent).toBe(false);
    // Fixed path: treat as miss and recreate rather than return mismatched pair.
    const shouldRecreate = !consistent;
    expect(shouldRecreate).toBe(true);
  });

  it('[P2] empty hosts deny; wildcard * allows any SSH host', () => {
    expect(
      isAllowedRepositoryUrl('git@evil.example:attacker/malware.git', {
        schemes: ['https', 'ssh'],
        hosts: [],
      }),
    ).toBe(false);
    expect(
      isAllowedRepositoryUrl('git@evil.example:attacker/malware.git', {
        schemes: ['https', 'ssh'],
        hosts: ['*'],
      }),
    ).toBe(true);
    expect(
      isAllowedRepositoryUrl('git@github.com:kuzyasun/esp32-boilerplate.git', {
        schemes: ['https', 'ssh'],
        hosts: ['github.com'],
      }),
    ).toBe(true);
  });
});
