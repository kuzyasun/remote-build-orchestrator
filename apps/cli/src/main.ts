import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  RBO_CONTROLLER_VERSION,
  resolveAgentStateDir,
  resolveControllerDataDir,
} from '@rbo/shared';
import { runAgentInit, runAgentStart, runAgentStopProcess } from './commands/agent.js';
import {
  approveAgentRemote,
  listAgentsRemote,
  probeAgentRemote,
  revokeAgentRemote,
} from './commands/agents.js';
import {
  runControllerFingerprint,
  runControllerInit,
  runControllerRestore,
  runControllerStart,
  runControllerStop,
} from './commands/controller.js';
import { stripDaemonFlag } from './commands/daemon.js';
import { formatDoctorCheckLine, runDoctor } from './commands/doctor.js';
import {
  parseDataDirFlag,
  parseForceFlag,
  parseReplaceFlag,
  parseStateDirFlag,
} from './commands/flags.js';
import { formatCliHelp } from './commands/help.js';
import {
  cancelJobRemote,
  followJobLogsRemote,
  getJobLogsRemote,
  submitJobRemote,
} from './commands/jobs.js';
import {
  RunInterruptedError,
  cancelAndAwaitJob,
  runJobWithLifecycle,
  runLifecycleErrorExitCode,
  takeRunFollowFlag,
  terminalExitCode,
  writeRunResult,
} from './commands/run-runtime.js';
import { parseRunCommandArgs, takeRunJsonFlag } from './commands/run.js';
import {
  type ServiceAction,
  detectPlatform,
  executeServicePlan,
  formatDryRunPlan,
  hasExecuteFlag,
  renderServiceActionPlan,
} from './commands/service.js';

function defaultControllerUrl(): string {
  return process.env.RBO_CONTROLLER_URL_HTTP ?? 'http://127.0.0.1:7410';
}

function printPlan(action: string, plan: Parameters<typeof formatDryRunPlan>[1]): void {
  console.log(formatDryRunPlan(action, plan));
}

async function confirmOnTerminal(
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await terminal.question(prompt, { signal })).trim());
  } finally {
    terminal.close();
  }
}

const SERVICE_ACTIONS = new Set<ServiceAction>(['install', 'uninstall', 'status', 'stop']);

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const controllerUrl = defaultControllerUrl();

  switch (command) {
    case undefined:
    case '--version':
    case '-v':
      console.log(`rbo CLI v${RBO_CONTROLLER_VERSION}`);
      return;

    case 'help':
    case '--help':
    case '-h':
      console.log(formatCliHelp());
      return;

    case 'controller': {
      const { dataDir: flagDataDir, rest: controllerArgs } = parseDataDirFlag(rest);
      const dataDir = flagDataDir ?? resolveControllerDataDir();
      const sub = controllerArgs[0];
      if (sub === 'init') {
        const { force } = parseForceFlag(controllerArgs.slice(1));
        const result = await runControllerInit({ dataDir, force });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === 'fingerprint') {
        const result = await runControllerFingerprint({ dataDir });
        console.log(result.fingerprint);
        return;
      }
      if (sub === 'restore') {
        const stagingDir = controllerArgs[1];
        if (!stagingDir) {
          throw new Error('Usage: rbo controller restore <staging-dir> [--data-dir <dir>]');
        }
        console.error(
          'Stop the Controller before restoring — this command does not check for one running.',
        );
        const result = await runControllerRestore({ stagingDir, dataDir });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === 'start') {
        const { daemon, args: afterDaemon } = stripDaemonFlag(controllerArgs.slice(1));
        const { replace } = parseReplaceFlag(afterDaemon);
        const result = await runControllerStart({
          dataDir,
          daemon,
          replace,
          cliScriptPath: process.argv[1],
        });
        if (result === null) {
          return;
        }
        if (typeof result === 'number') {
          console.log(result);
        }
        return;
      }
      if (sub === 'stop') {
        const result = await runControllerStop({ dataDir });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      throw new Error(
        `Unknown 'controller' subcommand '${sub}'. Use init|fingerprint|restore|start|stop.`,
      );
    }

    case 'agents': {
      const result = await listAgentsRemote(controllerUrl);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'agent': {
      const { stateDir: flagStateDir, rest: agentArgs } = parseStateDirFlag(rest);
      const stateDir = flagStateDir ?? resolveAgentStateDir();
      const sub = agentArgs[0];
      if (sub === 'approve') {
        const requestId = agentArgs[1];
        if (!requestId) throw new Error('Usage: rbo agent approve <pairing-request-id>');
        const result = await approveAgentRemote(controllerUrl, requestId);
        console.log(JSON.stringify(result));
        return;
      }
      if (sub === 'revoke') {
        const agentId = agentArgs[1];
        if (!agentId) throw new Error('Usage: rbo agent revoke <agent-id>');
        await revokeAgentRemote(controllerUrl, agentId);
        console.log(`revoked ${agentId}`);
        return;
      }
      if (sub === 'probe') {
        const agentId = agentArgs[1];
        if (!agentId) throw new Error('Usage: rbo agent probe <agent-id>');
        const result = await probeAgentRemote(controllerUrl, agentId);
        console.log(JSON.stringify(result));
        return;
      }
      if (sub === 'init') {
        const { force } = parseForceFlag(agentArgs.slice(1));
        const result = await runAgentInit({ stateDir, force });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === 'start') {
        const { daemon, args: afterDaemon } = stripDaemonFlag(agentArgs.slice(1));
        const { replace } = parseReplaceFlag(afterDaemon);
        const result = await runAgentStart({
          stateDir,
          daemon,
          replace,
          cliScriptPath: process.argv[1],
        });
        if (result === null) {
          return;
        }
        if (typeof result === 'number') {
          console.log(result);
        }
        return;
      }
      if (sub === 'stop-process') {
        const result = await runAgentStopProcess({ stateDir });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (SERVICE_ACTIONS.has(sub as ServiceAction)) {
        const platform = detectPlatform(process.platform);
        const action = sub as ServiceAction;
        const extraArgs = agentArgs.slice(1);
        const execute = hasExecuteFlag(extraArgs);
        const plan = renderServiceActionPlan(platform, action);
        const label = `agent ${action}`;
        if (!execute) {
          printPlan(label, plan);
          return;
        }
        const results = await executeServicePlan(plan);
        console.log(JSON.stringify(results, null, 2));
        if (results.some((result) => result.code !== 0)) {
          process.exitCode = 1;
        }
        return;
      }
      throw new Error(
        `Unknown 'agent' subcommand '${sub}'. Use approve|revoke|probe|init|start|stop-process|install|status|stop|uninstall.`,
      );
    }

    case 'doctor': {
      const { dataDir: flagDataDir } = parseDataDirFlag(rest);
      const dataDir = flagDataDir ?? resolveControllerDataDir();
      const report = await runDoctor({ dataDir, controllerUrl });
      for (const check of report.checks) {
        console.log(formatDoctorCheckLine(check));
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    case 'submit': {
      const requestPath = rest[0];
      if (!requestPath) {
        throw new Error('Usage: rbo submit <job-request.json>');
      }
      const request = JSON.parse(await readFile(requestPath, 'utf8')) as Record<string, unknown>;
      const result = await submitJobRemote(controllerUrl, request);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case 'run': {
      const { follow, args: withoutFollow } = takeRunFollowFlag(rest);
      const { json, args } = takeRunJsonFlag(withoutFollow);
      if (json && follow) {
        throw new Error('rbo run --json cannot be combined with --follow.');
      }
      const { request } = parseRunCommandArgs(args);
      const interruption = new AbortController();
      let jobId: string | null = null;
      let interruptCount = 0;
      const onInterrupt = () => {
        interruptCount += 1;
        if (interruptCount === 1) {
          process.stderr.write(
            jobId
              ? 'Interrupt received; requesting job cancellation.\n'
              : 'Interrupt received; waiting for a job ID so cancellation can be requested.\n',
          );
          interruption.abort();
        } else {
          process.stderr.write(
            jobId
              ? `Cancellation already requested for job ${jobId}.\n`
              : 'Cancellation will be requested when the Controller returns a job ID.\n',
          );
        }
      };
      process.on('SIGINT', onInterrupt);
      try {
        const result = await runJobWithLifecycle(controllerUrl, request, {
          follow,
          signal: interruption.signal,
          onJobId: (id) => {
            jobId = id;
          },
          io: {
            isTTY: process.stdin.isTTY === true,
            writeStderr: (text) => process.stderr.write(text),
            confirm: confirmOnTerminal,
          },
        });
        writeRunResult(result, {
          json,
          writeStdout: (text) => process.stdout.write(text),
          writeStderr: (text) => process.stderr.write(text),
        });
        process.exitCode = terminalExitCode(result);
      } catch (error) {
        if (error instanceof RunInterruptedError) {
          const interruptedJobId = error.jobId ?? jobId;
          if (interruptedJobId) {
            await cancelAndAwaitJob(controllerUrl, interruptedJobId, {
              writeStderr: (text) => process.stderr.write(text),
            });
          } else {
            process.stderr.write(
              'No job ID was received; no cancellation request could be sent.\n',
            );
          }
          process.exitCode = 130;
          return;
        }
        const lifecycleExit = runLifecycleErrorExitCode(error);
        if (lifecycleExit !== null) {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = lifecycleExit;
          return;
        }
        // A parsed request has already passed the Controller-owned protocol boundary. Remaining
        // runtime errors are Controller, transport, or malformed-response failures.
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 125;
      } finally {
        process.off('SIGINT', onInterrupt);
      }
      return;
    }

    case 'logs': {
      const jobId = rest[0];
      if (!jobId) {
        throw new Error('Usage: rbo logs <job-id> [--follow]');
      }
      const follow = rest.includes('--follow');
      if (follow) {
        await followJobLogsRemote(controllerUrl, jobId);
        return;
      }
      // Pull historical stdout/stderr using the opaque, attempt-scoped MCP cursor.
      let cursor: string | null = null;
      for (;;) {
        const result = await getJobLogsRemote(controllerUrl, jobId, {
          mode: 'logs',
          cursor,
          max_bytes: 65_536,
        });
        if (result.mode !== 'logs' || !Array.isArray(result.chunks)) {
          throw new Error('Malformed job_logs response: expected mode=logs and chunks[]');
        }
        for (const chunk of result.chunks) {
          if (
            !chunk ||
            typeof chunk !== 'object' ||
            typeof (chunk as { sequence?: unknown }).sequence !== 'number' ||
            ((chunk as { stream?: unknown }).stream !== 'stdout' &&
              (chunk as { stream?: unknown }).stream !== 'stderr') ||
            typeof (chunk as { text?: unknown }).text !== 'string' ||
            typeof (chunk as { complete?: unknown }).complete !== 'boolean'
          ) {
            throw new Error('Malformed job_logs response: invalid log chunk');
          }
          const stream = (chunk as { stream: 'stdout' | 'stderr' }).stream;
          const text = (chunk as { text: string }).text;
          (stream === 'stderr' ? process.stderr : process.stdout).write(text);
        }
        const next = result.next_cursor;
        if (next !== null && typeof next !== 'string') {
          throw new Error('Malformed job_logs response: next_cursor must be string or null');
        }
        if (result.has_more !== true) {
          break;
        }
        if (next === cursor) {
          throw new Error('job_logs made no cursor progress while has_more=true');
        }
        cursor = next;
      }
      return;
    }

    case 'cancel': {
      const jobId = rest[0];
      if (!jobId) {
        throw new Error('Usage: rbo cancel <job-id> [reason]');
      }
      const result = await cancelJobRemote(controllerUrl, jobId, rest[1]);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    default:
      throw new Error(`Unknown command '${command}'. Run \`rbo --help\` for usage.`);
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
