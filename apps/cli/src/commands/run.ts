import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { JOB_RUN_INPUT } from '@rbo/protocol';
import type { z } from 'zod';

export type JobRunInput = z.input<z.ZodObject<typeof JOB_RUN_INPUT>>;

export interface ParsedRunCommand {
  request: JobRunInput;
}

function usage(message: string): Error {
  return new Error(`${message}\nUsage: rbo run [options] -- <shell-command-string>`);
}

function takeOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw usage(`${option} requires a value.`);
  }
  return value;
}

function relativeCwd(projectRoot: string, value: string): string {
  if (isAbsolute(value)) {
    throw usage('--cwd must be a relative path inside --project.');
  }
  const resolved = resolve(projectRoot, value);
  const relativePath = relative(projectRoot, resolved);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw usage('--cwd must stay inside --project.');
  }
  return relativePath || '.';
}

/**
 * Parse the narrow R-01 CLI surface into the shared compact `job_run` input.
 * Controller-side Zod validation remains the source of truth for option values.
 */
export function parseRunCommandArgs(
  args: string[],
  currentDirectory: string = process.cwd(),
): ParsedRunCommand {
  const separator = args.indexOf('--');
  if (separator === -1) {
    throw usage('rbo run requires `--` before the target-shell command.');
  }
  const commandArgs = args.slice(separator + 1);
  if (commandArgs.length !== 1) {
    throw usage('rbo run accepts exactly one shell-command-string after `--`.');
  }

  let projectOption: string | undefined;
  let cwdOption: string | undefined;
  let shell: string | undefined;
  let timeoutSeconds: number | undefined;
  let riskLevel: string | undefined;
  let queuePolicy: string | undefined;
  const targetOs: string[] = [];
  const artifacts: Array<{ glob: string; required: false }> = [];

  const optionArgs = args.slice(0, separator);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    switch (option) {
      case '--project':
        projectOption = takeOptionValue(optionArgs, index, option);
        index += 1;
        break;
      case '--cwd':
        cwdOption = takeOptionValue(optionArgs, index, option);
        index += 1;
        break;
      case '--shell':
        shell = takeOptionValue(optionArgs, index, option);
        index += 1;
        break;
      case '--target-os':
        targetOs.push(takeOptionValue(optionArgs, index, option));
        index += 1;
        break;
      case '--timeout': {
        const rawTimeout = takeOptionValue(optionArgs, index, option);
        const parsedTimeout = Number(rawTimeout);
        if (!Number.isFinite(parsedTimeout)) {
          throw usage('--timeout must be a finite number of seconds.');
        }
        timeoutSeconds = parsedTimeout;
        index += 1;
        break;
      }
      case '--risk':
        riskLevel = takeOptionValue(optionArgs, index, option);
        index += 1;
        break;
      case '--artifact':
        artifacts.push({ glob: takeOptionValue(optionArgs, index, option), required: false });
        index += 1;
        break;
      case '--queue-policy':
        queuePolicy = takeOptionValue(optionArgs, index, option);
        index += 1;
        break;
      default:
        if (option.startsWith('--')) {
          throw usage(`Unknown rbo run option '${option}'.`);
        }
        throw usage(`Unexpected positional argument '${option}' before '--'.`);
    }
  }

  const projectRoot = resolve(currentDirectory, projectOption ?? currentDirectory);
  const cwd = relativeCwd(projectRoot, cwdOption ?? '.');
  return {
    request: {
      command: commandArgs[0],
      project_root: projectRoot,
      cwd,
      ...(shell !== undefined ? { shell } : {}),
      ...(targetOs.length > 0 ? { target_os: targetOs } : {}),
      ...(timeoutSeconds !== undefined ? { timeout_seconds: timeoutSeconds } : {}),
      ...(riskLevel !== undefined ? { risk_level: riskLevel } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(queuePolicy !== undefined ? { queue_policy: queuePolicy } : {}),
    },
  };
}
