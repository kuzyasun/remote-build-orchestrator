import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

const PROCESS_IDENTITY_RE = /^pid:(\d+):start:(\d+)$/;

/** Canonical wire format: pid:${pid}:start:${startMs} (unix ms). */
export function formatProcessIdentity(pid: number, startMs: number): string {
  return `pid:${pid}:start:${startMs}`;
}

export function parseProcessIdentity(identity: string): { pid: number; startMs: number } | null {
  const match = PROCESS_IDENTITY_RE.exec(identity);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  const startMs = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startMs) || startMs < 0) {
    return null;
  }
  return { pid, startMs };
}

/** Best-effort OS lookup; returns null when start time cannot be determined. */
export function processStartTimeMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const os = platform();
    if (os === 'linux') {
      return linuxProcessStartMs(pid);
    }
    if (os === 'win32') {
      return windowsProcessStartMs(pid);
    }
    if (os === 'darwin') {
      return darwinProcessStartMs(pid);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Build process identity from a live pid. Returns null when start time is
 * unavailable — callers must fail closed (do not adopt / do not persist).
 */
export function processIdentityFromPid(pid: number): string | null {
  const startMs = processStartTimeMs(pid);
  if (startMs === null) {
    return null;
  }
  return formatProcessIdentity(pid, startMs);
}

function linuxProcessStartMs(pid: number): number | null {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) {
    return null;
  }
  const parts = stat.slice(closeParen + 2).split(' ');
  const starttime = Number(parts[19]);
  if (!Number.isFinite(starttime)) {
    return null;
  }
  const btimeSec = linuxBtimeSec();
  if (btimeSec === null) {
    return null;
  }
  // USER_HZ is 100 for /proc. btime + starttime jiffies is stable across
  // reads; Date.now()-uptime drifted by 1ms and broke exact identity matches.
  const hz = 100;
  return btimeSec * 1000 + (starttime * 1000) / hz;
}

function linuxBtimeSec(): number | null {
  const stat = readFileSync('/proc/stat', 'utf8');
  for (const line of stat.split('\n')) {
    if (line.startsWith('btime ')) {
      const value = Number(line.slice(6).trim());
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

function windowsProcessStartMs(pid: number): number | null {
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 1 }; [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()"`,
      { encoding: 'utf8', timeout: 3_000, windowsHide: true },
    ).trim();
    const ms = Number(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function darwinProcessStartMs(pid: number): number | null {
  const out = execSync(`ps -p ${pid} -o lstart=`, {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  if (!out) {
    return null;
  }
  const ms = Date.parse(out);
  return Number.isFinite(ms) ? ms : null;
}
