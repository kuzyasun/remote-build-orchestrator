import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rbo-doctor-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('rbo doctor (§33)', () => {
  it('reports git, data dir permissions and shell checks with ok/detail per item', async () => {
    const dataDir = tempDir();
    const report = await runDoctor({ dataDir, controllerUrl: null });

    const names = report.checks.map((c) => c.name);
    expect(names).toContain('git');
    expect(names).toContain('data_dir_writable');
    expect(names).toContain('shell_executables');

    for (const check of report.checks) {
      expect(typeof check.ok).toBe('boolean');
      expect(typeof check.detail).toBe('string');
    }
  });

  it('marks data_dir_writable false when the directory cannot be created', async () => {
    // A path nested under a file (not a directory) can never be created.
    const dataDir = join(tempDir(), 'blocked-file', 'nested');
    const report = await runDoctor({ dataDir: '\0invalid', controllerUrl: null });
    const check = report.checks.find((c) => c.name === 'data_dir_writable');
    expect(check?.ok).toBe(false);
  });

  it('includes a controller_reachable check only when a controller URL is given', async () => {
    const withUrl = await runDoctor({ dataDir: tempDir(), controllerUrl: 'http://127.0.0.1:1' });
    expect(withUrl.checks.map((c) => c.name)).toContain('controller_reachable');

    const withoutUrl = await runDoctor({ dataDir: tempDir(), controllerUrl: null });
    expect(withoutUrl.checks.map((c) => c.name)).not.toContain('controller_reachable');
  });

  it('overall ok is false if any check fails', async () => {
    const report = await runDoctor({ dataDir: tempDir(), controllerUrl: 'http://127.0.0.1:1' });
    const reachable = report.checks.find((c) => c.name === 'controller_reachable');
    expect(reachable?.ok).toBe(false);
    expect(report.ok).toBe(false);
  }, 15_000);
});
