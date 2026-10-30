import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LinuxCgroupScope {
  cgroupDir: string;
  addPid(pid: number): Promise<boolean>;
  listPids(): Promise<number[]>;
  kill(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Creates a dedicated cgroup v2 sub-cgroup scope for an attempt on Linux (§15.2).
 * When cgroup v2 is enabled and writable, all child and grandchild processes
 * remain contained within this cgroup even if they call setsid() or change process group.
 */
export async function createLinuxCgroupScope(attemptId: string): Promise<LinuxCgroupScope | null> {
  if (process.platform !== 'linux') {
    return null;
  }
  const controllersPath = '/sys/fs/cgroup/cgroup.controllers';
  if (!existsSync(controllersPath)) {
    return null;
  }
  try {
    const cgroupContent = await readFile('/proc/self/cgroup', 'utf8');
    const match = cgroupContent.match(/^0::(.*)$/m);
    if (!match) {
      return null;
    }
    const subpath = match[1]?.trim() ?? '';
    const baseDir = join('/sys/fs/cgroup', subpath.replace(/^\/+/, ''));
    const sanitizedId = attemptId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cgroupDir = join(baseDir, `rbo-${sanitizedId}`);
    await mkdir(cgroupDir, { recursive: true });

    const listPids = async (): Promise<number[]> => {
      try {
        const content = await readFile(join(cgroupDir, 'cgroup.procs'), 'utf8');
        return content
          .split('\n')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
      } catch {
        return [];
      }
    };

    return {
      cgroupDir,
      async addPid(pid: number): Promise<boolean> {
        try {
          await writeFile(join(cgroupDir, 'cgroup.procs'), String(pid));
          return true;
        } catch {
          return false;
        }
      },
      listPids,
      async kill(): Promise<void> {
        const killFile = join(cgroupDir, 'cgroup.kill');
        try {
          await writeFile(killFile, '1');
        } catch {
          const pids = await listPids();
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // already gone
            }
          }
        }
      },
      async cleanup(): Promise<void> {
        for (let i = 0; i < 3; i++) {
          try {
            await rmdir(cgroupDir);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      },
    };
  } catch {
    return null;
  }
}

async function findLinuxAttemptPids(attemptId: string): Promise<number[]> {
  const pids: number[] = [];
  try {
    const entries = await readdir('/proc');
    const numericEntries = entries.filter((e) => /^\d+$/.test(e) && Number(e) !== process.pid);
    const targetVar = `RBO_ATTEMPT_ID=${attemptId}`;
    const batchSize = 64;

    for (let i = 0; i < numericEntries.length; i += batchSize) {
      const batch = numericEntries.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (entry) => {
          try {
            const raw = await readFile(`/proc/${entry}/environ`, 'utf8');
            const vars = raw.split('\0');
            if (vars.some((v) => v === targetVar)) {
              pids.push(Number(entry));
            }
          } catch {
            // Process exited or owned by another user (EACCES/ENOENT)
          }
        }),
      );
    }
  } catch {
    // /proc unreadable
  }
  return pids;
}

async function findDarwinAttemptPids(attemptId: string): Promise<number[]> {
  const pids: number[] = [];
  try {
    const { RBO_ATTEMPT_ID: _omit, ...cleanEnv } = process.env;
    const { stdout } = await execFileAsync('ps', ['-E', '-A', '-ww', '-o', 'pid=,command='], {
      env: cleanEnv,
    });
    const regex = new RegExp(`(?:^|\\s)RBO_ATTEMPT_ID=${attemptId}(?:\\s|$)`);
    for (const line of stdout.split('\n')) {
      if (regex.test(line)) {
        const match = line.trim().match(/^(\d+)\s+/);
        if (match) {
          const pid = Number(match[1]);
          if (Number.isFinite(pid) && pid !== process.pid) {
            pids.push(pid);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return pids;
}

/**
 * Scans live processes for any that contain `RBO_ATTEMPT_ID=<attemptId>` in their environment.
 * Catches orphaned processes (e.g. spawned via setsid or nohup and reparented to PID 1)
 * that cannot be reached by parent-child tree walk or process group signals.
 */
export async function findAttemptPids(attemptId: string): Promise<number[]> {
  if (!attemptId || process.platform === 'win32') {
    return [];
  }
  if (process.platform === 'linux') {
    return findLinuxAttemptPids(attemptId);
  }
  if (process.platform === 'darwin') {
    return findDarwinAttemptPids(attemptId);
  }
  return [];
}
