import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  dataDir: string;
  controllerUrl: string | null;
}

async function checkGit(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    return { name: 'git', ok: true, detail: stdout.trim() };
  } catch (error) {
    return { name: 'git', ok: false, detail: `git not found: ${String(error)}` };
  }
}

function checkDataDirWritable(dataDir: string): DoctorCheck {
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, '.rbo-doctor-probe');
    writeFileSync(probe, 'ok');
    return { name: 'data_dir_writable', ok: true, detail: dataDir };
  } catch (error) {
    return { name: 'data_dir_writable', ok: false, detail: String(error) };
  }
}

async function checkShellExecutables(): Promise<DoctorCheck> {
  const candidates =
    process.platform === 'win32'
      ? [
          ['powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']],
          ['cmd.exe', ['/c', 'ver']],
        ]
      : [
          ['bash', ['--version']],
          ['sh', ['-c', 'echo ok']],
        ];

  const found: string[] = [];
  for (const [cmd, args] of candidates) {
    try {
      await execFileAsync(cmd as string, args as string[]);
      found.push(cmd as string);
    } catch {
      // shell not present — not fatal on its own
    }
  }
  return {
    name: 'shell_executables',
    ok: found.length > 0,
    detail: found.length > 0 ? `available: ${found.join(', ')}` : 'no supported shell found',
  };
}

async function checkControllerReachable(controllerUrl: string): Promise<DoctorCheck> {
  try {
    const res = await fetch(`${controllerUrl.replace(/\/+$/, '')}/internal/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return {
      name: 'controller_reachable',
      ok: res.ok,
      detail: res.ok ? controllerUrl : `HTTP ${res.status}`,
    };
  } catch (error) {
    return { name: 'controller_reachable', ok: false, detail: String(error) };
  }
}

// `rbo doctor` (§33): git, controller port reachability, data dir permissions
// and shell executables run locally; database/compression/TLS/snapshot checks
// arrive with their respective phases (§35).
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    await checkGit(),
    checkDataDirWritable(options.dataDir),
    await checkShellExecutables(),
  ];

  if (options.controllerUrl) {
    checks.push(await checkControllerReachable(options.controllerUrl));
  }

  return { ok: checks.every((c) => c.ok), checks };
}
