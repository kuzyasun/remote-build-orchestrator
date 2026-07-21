/**
 * Boolean `--force` flag for init (rewrite default operator config).
 * Remaining tokens returned as `rest`.
 */
export function parseForceFlag(args: string[]): { force: boolean; rest: string[] } {
  const rest: string[] = [];
  let force = false;
  for (const arg of args) {
    if (arg === '--force') {
      force = true;
      continue;
    }
    rest.push(arg);
  }
  return { force, rest };
}

/** Parse `--data-dir <path>` from argv; remaining tokens returned as `rest`. */
export function parseDataDirFlag(args: string[]): { dataDir?: string; rest: string[] } {
  const rest: string[] = [];
  let dataDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--data-dir') {
      dataDir = args[index + 1];
      if (!dataDir) {
        throw new Error('--data-dir requires a directory path');
      }
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { dataDir, rest };
}

/** Parse `--state-dir <path>` from argv; remaining tokens returned as `rest`. */
export function parseStateDirFlag(args: string[]): { stateDir?: string; rest: string[] } {
  const rest: string[] = [];
  let stateDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--state-dir') {
      stateDir = args[index + 1];
      if (!stateDir) {
        throw new Error('--state-dir requires a directory path');
      }
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { stateDir, rest };
}
