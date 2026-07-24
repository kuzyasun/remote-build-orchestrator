/**
 * Type surface for `scripts/stop-running-rbo.mjs` (bundled into the CLI by esbuild).
 * Keep in sync with the .mjs exports used by process-lifecycle.
 */

export type RboDaemonRole = 'controller' | 'agent';

export function shouldSkipInstallStop(env?: NodeJS.ProcessEnv): boolean;

export function matchRboDaemonRole(commandLine: string | undefined | null): RboDaemonRole | null;

export function resolveDaemonPidFiles(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  dataDir?: string;
  stateDir?: string;
}): { role: RboDaemonRole; path: string }[];

export function resolveRolePidFile(
  role: RboDaemonRole,
  options?: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    dataDir?: string;
    stateDir?: string;
  },
): string;

export function clearStalePidFile(pidFile: string, isAlive: (pid: number) => boolean): boolean;

export function readLivePidFromFile(
  pidFile: string,
  isAlive: (pid: number) => boolean,
): number | null;

export function isProcessAlive(pid: number): boolean;

export function listNodeProcesses(): Promise<{ pid: number; commandLine: string }[]>;

export function stopPid(
  pid: number,
  options?: {
    platform?: NodeJS.Platform;
    isAlive?: (pid: number) => boolean;
    sleepMs?: (ms: number) => Promise<void>;
  },
): Promise<void>;

export function findLiveRolePids(
  role: RboDaemonRole,
  options?: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    dataDir?: string;
    stateDir?: string;
    listProcesses?: () => Promise<{ pid: number; commandLine: string }[]>;
    isAlive?: (pid: number) => boolean;
    selfPid?: number;
  },
): Promise<number[]>;

export function stopRoleProcesses(
  role: RboDaemonRole,
  options?: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    dataDir?: string;
    stateDir?: string;
    listProcesses?: () => Promise<{ pid: number; commandLine: string }[]>;
    isAlive?: (pid: number) => boolean;
    stopPid?: (pid: number) => Promise<void>;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    selfPid?: number;
    strict?: boolean;
  },
): Promise<{ stopped: number[]; alreadyStopped: boolean }>;

export function stopRunningRbo(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  listProcesses?: () => Promise<{ pid: number; commandLine: string }[]>;
  isAlive?: (pid: number) => boolean;
  stopPid?: (pid: number) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  extraPids?: number[];
}): Promise<void>;
