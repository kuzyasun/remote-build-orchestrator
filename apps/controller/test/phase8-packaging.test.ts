import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type PackagingManifest,
  buildBaseManifest,
  isForbiddenPackagingPath,
  verifyArchiveManifest,
} from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { renderServiceActionPlan } from '../../cli/src/commands/service.js';

const ROOT = process.cwd();

describe('Phase 8 packaging manifests', () => {
  for (const os of ['windows', 'macos', 'linux'] as const) {
    it(`validates ${os} MANIFEST.json structure and exclusions`, async () => {
      const raw = JSON.parse(
        await readFile(join(ROOT, 'packaging', os, 'MANIFEST.json'), 'utf8'),
      ) as PackagingManifest & {
        files: Array<{ path: string; sha256: string; size_bytes: number }>;
      };

      expect(raw.schema_version).toBe(1);
      expect(raw.components.controller).toBeTruthy();
      expect(raw.components.agent).toBeTruthy();
      expect(raw.components.cli).toBeTruthy();
      expect(raw.components.mcp_stdio).toBeTruthy();
      if (os === 'windows') {
        expect(raw.components.windows_executor).toBeTruthy();
      }

      for (const file of raw.files) {
        expect(isForbiddenPackagingPath(file.path)).toBe(false);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/i);
      }

      const base = buildBaseManifest(os);
      base.files = raw.files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        size_bytes: f.size_bytes,
      }));
      expect(verifyArchiveManifest(base).ok).toBe(true);
    });
  }

  it('renders install/uninstall/status plans for all OS (elevated e2e PLATFORM-GAP)', () => {
    // PLATFORM-GAP: Real elevated sc.exe/launchctl/systemctl e2e requires admin
    // privileges and matching OS — verify on target runners with --execute.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const action of ['install', 'uninstall', 'status', 'start', 'stop'] as const) {
        const plan = renderServiceActionPlan(platform, action);
        expect(plan.commands.length).toBeGreaterThan(0);
      }
    }
  });
});
