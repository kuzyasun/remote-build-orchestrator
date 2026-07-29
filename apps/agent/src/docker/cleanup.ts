import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@rbo/shared';

const logger = createLogger('agent.docker.cleanup');
const execFileAsync = promisify(execFile);

export interface DockerLabelCleanupOptions {
  attemptId: string;
  jobId?: string;
  dockerBin?: string;
  /** Bound for the whole cleanup sequence. Default 60_000. */
  timeoutMs?: number;
}

export interface DockerCleanupResult {
  containersRemoved: string[];
  networksRemoved: string[];
  volumesRemoved: string[];
  skipped: boolean;
  reason?: string;
}

export type DockerRunner = (
  bin: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const DEFAULT_TIMEOUT_MS = 60_000;

export async function defaultDockerRunner(
  bin: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      stdout: typeof stdout === 'string' ? stdout : String(stdout),
      stderr: typeof stderr === 'string' ? stderr : String(stderr),
      code: 0,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
      killed?: boolean;
      signal?: string;
    };
    if (err.code === 'ENOENT') {
      throw err;
    }
    // execFile rejects on non-zero exit; surface stdout for list parsing when present.
    return {
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(error),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

function parseIds(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function attemptFilter(attemptId: string): string {
  return `label=rbo.attempt=${attemptId}`;
}

/**
 * Remove Docker containers, networks, and volumes labelled with the exact
 * attempt id. Never runs global prune / system prune.
 */
export async function cleanupDockerResourcesForAttempt(
  options: DockerLabelCleanupOptions,
  run: DockerRunner = defaultDockerRunner,
): Promise<DockerCleanupResult> {
  const bin = options.dockerBin ?? 'docker';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const filter = attemptFilter(options.attemptId);
  const empty: DockerCleanupResult = {
    containersRemoved: [],
    networksRemoved: [],
    volumesRemoved: [],
    skipped: false,
  };

  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  try {
    const containers = parseIds(
      (
        await run(bin, ['ps', '-aq', '--filter', filter], {
          timeoutMs: remaining(),
        })
      ).stdout,
    );

    if (containers.length > 0) {
      await run(bin, ['rm', '-f', ...containers], { timeoutMs: remaining() });
    }

    const networks = parseIds(
      (
        await run(bin, ['network', 'ls', '-q', '--filter', filter], {
          timeoutMs: remaining(),
        })
      ).stdout,
    );
    if (networks.length > 0) {
      await run(bin, ['network', 'rm', ...networks], { timeoutMs: remaining() });
    }

    const volumes = parseIds(
      (
        await run(bin, ['volume', 'ls', '-q', '--filter', filter], {
          timeoutMs: remaining(),
        })
      ).stdout,
    );
    if (volumes.length > 0) {
      await run(bin, ['volume', 'rm', ...volumes], { timeoutMs: remaining() });
    }

    logger.info('docker label-scoped cleanup complete', {
      attemptId: options.attemptId,
      jobId: options.jobId,
      containers: containers.length,
      networks: networks.length,
      volumes: volumes.length,
    });

    return {
      containersRemoved: containers,
      networksRemoved: networks,
      volumesRemoved: volumes,
      skipped: false,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        ...empty,
        skipped: true,
        reason: 'docker_unavailable',
      };
    }
    throw error;
  }
}
