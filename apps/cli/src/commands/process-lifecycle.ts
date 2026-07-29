import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { findLiveRolePids, stopRoleProcesses } from '../../scripts/stop-running-rbo.mjs';

export type RboDaemonRole = 'controller' | 'agent';

function capitalize(role: RboDaemonRole): string {
  return role === 'controller' ? 'Controller' : 'Agent';
}

function formatPidList(pids: number[]): string {
  return pids.join(', ');
}

export type PromptFn = (question: string) => Promise<string>;

export async function defaultTtyPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: defaultStdin, output: defaultStdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Decide whether to stop an already-running role before start.
 * @returns `'replace'` to stop+start, `'abort'` when the operator declined (TTY only).
 * @throws when non-TTY and `--replace` was not passed.
 */
export async function confirmReplaceOrThrow(options: {
  role: RboDaemonRole;
  pids: number[];
  replace: boolean;
  isTTY?: boolean;
  prompt?: PromptFn;
}): Promise<'replace' | 'abort'> {
  const label = capitalize(options.role);
  const pidText = formatPidList(options.pids);

  if (options.replace) {
    return 'replace';
  }

  const isTTY = options.isTTY ?? Boolean(defaultStdin.isTTY);
  if (!isTTY) {
    throw new Error(
      `${label} already running (pid ${pidText}). Pass --replace to restart it, or run \`rbo ${options.role === 'controller' ? 'controller stop' : 'agent stop-process'}\`.`,
    );
  }

  const prompt = options.prompt ?? defaultTtyPrompt;
  const answer = (await prompt(`${label} already running (pid ${pidText}). Restart it? [Y/n] `))
    .trim()
    .toLowerCase();
  if (answer === '' || answer === 'y' || answer === 'yes') {
    return 'replace';
  }
  return 'abort';
}

export interface RoleDirs {
  dataDir?: string;
  stateDir?: string;
}

export interface ProcessLifecycleDeps {
  findPids?: typeof findLiveRolePids;
  stopRole?: typeof stopRoleProcesses;
  confirm?: typeof confirmReplaceOrThrow;
  log?: (msg: string) => void;
  isTTY?: boolean;
  prompt?: PromptFn;
}

/**
 * If the role is already live, confirm/replace and stop it.
 * @returns true when start should proceed; false when the operator declined (caller exits 0).
 */
export async function ensureNotRunningOrReplace(
  role: RboDaemonRole,
  options: RoleDirs & { replace?: boolean } & ProcessLifecycleDeps = {},
): Promise<boolean> {
  const findPids = options.findPids ?? findLiveRolePids;
  const stopRole = options.stopRole ?? stopRoleProcesses;
  const confirm = options.confirm ?? confirmReplaceOrThrow;
  const log = options.log ?? ((msg: string) => console.error(`[rbo] ${msg}`));

  const pids = await findPids(role, {
    dataDir: options.dataDir,
    stateDir: options.stateDir,
  });
  if (pids.length === 0) {
    return true;
  }

  const decision = await confirm({
    role,
    pids,
    replace: options.replace === true,
    isTTY: options.isTTY,
    prompt: options.prompt,
  });
  if (decision === 'abort') {
    log(`${capitalize(role)} left running (pid ${formatPidList(pids)}).`);
    return false;
  }

  const result = await stopRole(role, {
    dataDir: options.dataDir,
    stateDir: options.stateDir,
    strict: true,
    log,
  });
  log(
    result.stopped.length > 0
      ? `stopped ${role} pid=${formatPidList(result.stopped)}`
      : `${capitalize(role)} already stopped`,
  );
  return true;
}

export async function stopRoleForCli(
  role: RboDaemonRole,
  options: RoleDirs & ProcessLifecycleDeps = {},
): Promise<{ stopped: number[]; alreadyStopped: boolean }> {
  const findPids = options.findPids ?? findLiveRolePids;
  const stopRole = options.stopRole ?? stopRoleProcesses;
  const log = options.log ?? ((msg: string) => console.error(`[rbo] ${msg}`));

  const pids = await findPids(role, {
    dataDir: options.dataDir,
    stateDir: options.stateDir,
  });
  if (pids.length === 0) {
    log(`${capitalize(role)} is not running.`);
    return { stopped: [], alreadyStopped: true };
  }

  const result = await stopRole(role, {
    dataDir: options.dataDir,
    stateDir: options.stateDir,
    strict: true,
    log,
  });
  log(
    result.stopped.length > 0
      ? `stopped ${role} pid=${formatPidList(result.stopped)}`
      : `${capitalize(role)} already stopped`,
  );
  return result;
}
