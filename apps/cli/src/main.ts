import { readFile } from 'node:fs/promises';
import { RBO_CONTROLLER_VERSION } from '@rbo/shared';
import {
  approveAgentRemote,
  listAgentsRemote,
  probeAgentRemote,
  revokeAgentRemote,
} from './commands/agents.js';
import { runControllerFingerprint, runControllerInit } from './commands/controller.js';
import { runDoctor } from './commands/doctor.js';
import { cancelJobRemote, getJobLogsRemote, submitJobRemote } from './commands/jobs.js';
import {
  detectPlatform,
  renderServiceInstallPlan,
  renderServiceUninstallPlan,
} from './commands/service.js';

function defaultDataDir(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return `${process.env.LOCALAPPDATA}/RBO`;
  }
  return `${process.env.HOME ?? '.'}/.rbo`;
}

function defaultControllerUrl(): string {
  return process.env.RBO_CONTROLLER_URL_HTTP ?? 'http://127.0.0.1:7410';
}

function printPlan(action: string, plan: { commands: string[] }): void {
  console.log(`# ${action} (dry run — pass --execute to run these commands)`);
  for (const command of plan.commands) {
    console.log(command);
  }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const dataDir = process.env.RBO_DATA_DIR ?? defaultDataDir();
  const controllerUrl = defaultControllerUrl();

  switch (command) {
    case undefined:
    case '--version':
    case '-v':
      console.log(`rbo CLI v${RBO_CONTROLLER_VERSION}`);
      return;

    case 'controller': {
      const sub = rest[0];
      if (sub === 'init') {
        const result = await runControllerInit({ dataDir });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (sub === 'fingerprint') {
        const result = await runControllerFingerprint({ dataDir });
        console.log(result.fingerprint);
        return;
      }
      throw new Error(`Unknown 'controller' subcommand '${sub}'. Use init|fingerprint.`);
    }

    case 'agents': {
      const result = await listAgentsRemote(controllerUrl);
      console.log(JSON.stringify(result.agents, null, 2));
      return;
    }

    case 'agent': {
      const sub = rest[0];
      if (sub === 'approve') {
        const requestId = rest[1];
        if (!requestId) throw new Error('Usage: rbo agent approve <pairing-request-id>');
        const result = await approveAgentRemote(controllerUrl, requestId);
        console.log(JSON.stringify(result));
        return;
      }
      if (sub === 'revoke') {
        const agentId = rest[1];
        if (!agentId) throw new Error('Usage: rbo agent revoke <agent-id>');
        await revokeAgentRemote(controllerUrl, agentId);
        console.log(`revoked ${agentId}`);
        return;
      }
      if (sub === 'probe') {
        const agentId = rest[1];
        if (!agentId) throw new Error('Usage: rbo agent probe <agent-id>');
        const result = await probeAgentRemote(controllerUrl, agentId);
        console.log(JSON.stringify(result));
        return;
      }
      if (sub === 'install' || sub === 'uninstall') {
        const platform = detectPlatform(process.platform);
        const plan =
          sub === 'install'
            ? renderServiceInstallPlan(platform)
            : renderServiceUninstallPlan(platform);
        printPlan(`agent ${sub}`, plan);
        return;
      }
      if (sub === 'status' || sub === 'start' || sub === 'stop') {
        console.log(
          `'rbo agent ${sub}' delegates to the OS service manager (${detectPlatform(process.platform)}); not yet wired to a live service in this build.`,
        );
        return;
      }
      throw new Error(
        `Unknown 'agent' subcommand '${sub}'. Use approve|revoke|probe|install|status|start|stop|uninstall.`,
      );
    }

    case 'doctor': {
      const report = await runDoctor({ dataDir, controllerUrl });
      for (const check of report.checks) {
        console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}: ${check.detail}`);
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
