import { describe, expect, it } from 'vitest';
import { buildJobRunRequest, wrapCommandAsExecution } from '../src/jobs/job-run.js';

describe('wrapCommandAsExecution', () => {
  it('wraps Windows commands with PowerShell fail-closed exit handling', () => {
    const exec = wrapCommandAsExecution('eim run "idf.py build"', 120, 'win32');
    expect(exec.shell).toBe('powershell');
    expect(exec.timeout_seconds).toBe(120);
    expect(exec.script).toContain("$ErrorActionPreference = 'Stop'");
    expect(exec.script).toContain('eim run "idf.py build"');
    expect(exec.script).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  });

  it('wraps Unix commands with bash set -euo pipefail', () => {
    const exec = wrapCommandAsExecution('make test', 60, 'linux');
    expect(exec.shell).toBe('bash');
    expect(exec.timeout_seconds).toBe(60);
    expect(exec.script).toBe('set -euo pipefail\nmake test\n');
  });
});

describe('buildJobRunRequest', () => {
  it('builds a JobRequest with defaults and derived name', () => {
    const request = buildJobRunRequest(
      {
        command: 'echo hello',
        project_root: 'C:/projects/app',
        artifacts: [{ glob: 'out.txt', required: true }],
      },
      'win32',
    );
    expect(request.source.project_root).toBe('C:/projects/app');
    expect(request.source.cwd).toBe('.');
    expect(request.risk_level).toBe('normal');
    expect(request.name).toBe('echo hello');
    expect(request.client_request_id).toMatch(/^req_/);
    expect(request.execution.shell).toBe('powershell');
    expect(request.artifacts).toEqual([{ glob: 'out.txt', required: true }]);
  });

  it('honours explicit name, cwd, risk_level, and client_request_id', () => {
    const request = buildJobRunRequest(
      {
        command: 'npm test',
        project_root: '/tmp/app',
        cwd: 'packages/core',
        name: 'unit',
        risk_level: 'safe',
        client_request_id: 'req_custom',
        timeout_seconds: 90,
      },
      'linux',
    );
    expect(request.name).toBe('unit');
    expect(request.source.cwd).toBe('packages/core');
    expect(request.risk_level).toBe('safe');
    expect(request.client_request_id).toBe('req_custom');
    expect(request.execution.timeout_seconds).toBe(90);
    expect(request.execution.shell).toBe('bash');
  });

  it('rejects build without command/project_root', () => {
    expect(() => buildJobRunRequest({ command: 'echo hi' }, 'linux')).toThrow(/project_root/);
  });
});
