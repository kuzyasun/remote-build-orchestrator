import { readFile } from 'node:fs/promises';
import {
  RBO_CONTROLLER_VERSION,
  resolveAgentStateDir,
  resolveControllerDataDir,
} from '@rbo/shared';
import { runAgentInit, runAgentStart } from './commands/agent.js';
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
} from './commands/controller.js';
import { stripDaemonFlag } from './commands/daemon.js';
import { formatDoctorCheckLine, runDoctor } from './commands/doctor.js';
import { parseDataDirFlag, parseForceFlag, parseStateDirFlag } from './commands/flags.js';
import { cancelJobRemote, getJobLogsRemote, submitJobRemote } from './commands/jobs.js';
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
        const { daemon } = stripDaemonFlag(controllerArgs.slice(1));
        const result = await runControllerStart({
          dataDir,
          daemon,
          cliScriptPath: process.argv[1],
        });
        if (typeof result === 'number') {
          console.log(result);
        }
        return;
      }
      throw new Error(
        `Unknown 'controller' subcommand '${sub}'. Use init|fingerprint|restore|start.`,
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
        const { daemon } = stripDaemonFlag(agentArgs.slice(1));
        const result = await runAgentStart({
          stateDir,
          daemon,
          cliScriptPath: process.argv[1],
        });
        if (typeof result === 'number') {
          console.log(result);
        }
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
        `Unknown 'agent' subcommand '${sub}'. Use approve|revoke|probe|init|start|install|status|stop|uninstall.`,
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

    case 'logs': {
      const jobId = rest[0];
      if (!jobId) {
        throw new Error('Usage: rbo logs <job-id>');
      }
      const result = await getJobLogsRemote(controllerUrl, jobId);
      console.log(JSON.stringify(result, null, 2));
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
      throw new Error(`Unknown command '${command}'.`);
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
