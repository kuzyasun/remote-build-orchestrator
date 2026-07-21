// OS service lifecycle plans for `rbo agent install|status|start|stop|uninstall`
// (§33, §35 Phase 2). Each plan lists the exact commands for the target OS;
// the CLI's install/uninstall handlers execute them when `--execute` is passed.
// Kept as pure data here so plans are unit-testable without touching the real
// service manager.
//
// PLATFORM-GAP: Real elevated end-to-end install/start/stop against sc.exe,
// launchctl, or systemctl requires administrator privileges and is not run in
// CI — only mock CommandRunner tests gate this remediation.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SupportedPlatform = 'win32' | 'darwin' | 'linux';

export type ServiceAction = 'install' | 'uninstall' | 'status' | 'start' | 'stop';

export function detectPlatform(nodePlatform: string): SupportedPlatform {
  if (nodePlatform === 'win32' || nodePlatform === 'darwin' || nodePlatform === 'linux') {
    return nodePlatform;
  }
  throw new Error(`Unsupported platform '${nodePlatform}'`);
}

export interface ServiceInstallPlan {
  kind: 'windows_service' | 'launchd' | 'systemd';
  serviceName: string;
  commands: string[];
}

export interface CommandRunResult {
  command: string;
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  run(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export const defaultCommandRunner: CommandRunner = {
  async run(command: string) {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const flag = process.platform === 'win32' ? '/c' : '-c';
    try {
      const { stdout, stderr } = await execFileAsync(shell, [flag, command], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
        code: failed.code ?? 1,
      };
    }
  },
};

const SERVICE_NAME = 'RBOAgent';
const LAUNCHD_LABEL = 'com.rbo.agent';
const SYSTEMD_UNIT = 'rbo-agent';

export function renderServiceInstallPlan(
  platform: SupportedPlatform,
  executablePath = 'C:/Program Files/RBO/rbo-agent.exe',
): ServiceInstallPlan {
  switch (platform) {
    case 'win32':
      return {
        kind: 'windows_service',
        serviceName: SERVICE_NAME,
        commands: [
          `sc.exe create ${SERVICE_NAME} binPath= "${executablePath}" start= auto`,
          `sc.exe description ${SERVICE_NAME} "Remote Build Orchestrator Agent"`,
          `sc.exe start ${SERVICE_NAME}`,
        ],
      };
    case 'darwin':
      return {
        kind: 'launchd',
        serviceName: LAUNCHD_LABEL,
        commands: [
          `launchctl load -w /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`,
          `launchctl start ${LAUNCHD_LABEL}`,
        ],
      };
    case 'linux':
      return {
        kind: 'systemd',
        serviceName: SYSTEMD_UNIT,
        commands: [
          'systemctl daemon-reload',
          `systemctl enable ${SYSTEMD_UNIT}`,
          `systemctl start ${SYSTEMD_UNIT}`,
        ],
      };
  }
}

export function renderServiceUninstallPlan(platform: SupportedPlatform): ServiceInstallPlan {
  switch (platform) {
    case 'win32':
      return {
        kind: 'windows_service',
        serviceName: SERVICE_NAME,
        commands: [`sc.exe stop ${SERVICE_NAME}`, `sc.exe delete ${SERVICE_NAME}`],
      };
    case 'darwin':
      return {
        kind: 'launchd',
        serviceName: LAUNCHD_LABEL,
        commands: [
          `launchctl stop ${LAUNCHD_LABEL}`,
          `launchctl unload -w /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`,
        ],
      };
    case 'linux':
      return {
        kind: 'systemd',
        serviceName: SYSTEMD_UNIT,
        commands: [
          `systemctl stop ${SYSTEMD_UNIT}`,
          `systemctl disable ${SYSTEMD_UNIT}`,
          'systemctl daemon-reload',
        ],
      };
  }
}

export function renderServiceStatusPlan(platform: SupportedPlatform): ServiceInstallPlan {
  switch (platform) {
    case 'win32':
      return {
        kind: 'windows_service',
        serviceName: SERVICE_NAME,
        commands: [`sc.exe query ${SERVICE_NAME}`],
      };
    case 'darwin':
      return {
        kind: 'launchd',
        serviceName: LAUNCHD_LABEL,
        commands: [`launchctl print system/${LAUNCHD_LABEL}`],
      };
    case 'linux':
      return {
        kind: 'systemd',
        serviceName: SYSTEMD_UNIT,
        commands: [`systemctl status ${SYSTEMD_UNIT}`],
      };
  }
}

export function renderServiceStartPlan(platform: SupportedPlatform): ServiceInstallPlan {
  switch (platform) {
    case 'win32':
      return {
        kind: 'windows_service',
        serviceName: SERVICE_NAME,
        commands: [`sc.exe start ${SERVICE_NAME}`],
      };
    case 'darwin':
      return {
        kind: 'launchd',
        serviceName: LAUNCHD_LABEL,
        commands: [`launchctl start ${LAUNCHD_LABEL}`],
      };
    case 'linux':
      return {
        kind: 'systemd',
        serviceName: SYSTEMD_UNIT,
        commands: [`systemctl start ${SYSTEMD_UNIT}`],
      };
  }
}

export function renderServiceStopPlan(platform: SupportedPlatform): ServiceInstallPlan {
  switch (platform) {
    case 'win32':
      return {
        kind: 'windows_service',
        serviceName: SERVICE_NAME,
        commands: [`sc.exe stop ${SERVICE_NAME}`],
      };
    case 'darwin':
      return {
        kind: 'launchd',
        serviceName: LAUNCHD_LABEL,
        commands: [`launchctl stop ${LAUNCHD_LABEL}`],
      };
    case 'linux':
      return {
        kind: 'systemd',
        serviceName: SYSTEMD_UNIT,
        commands: [`systemctl stop ${SYSTEMD_UNIT}`],
      };
  }
}

export function renderServiceActionPlan(
  platform: SupportedPlatform,
  action: ServiceAction,
  executablePath?: string,
): ServiceInstallPlan {
  switch (action) {
    case 'install':
      return renderServiceInstallPlan(platform, executablePath);
    case 'uninstall':
      return renderServiceUninstallPlan(platform);
    case 'status':
      return renderServiceStatusPlan(platform);
    case 'start':
      return renderServiceStartPlan(platform);
    case 'stop':
      return renderServiceStopPlan(platform);
  }
}

export function hasExecuteFlag(args: string[]): boolean {
  return args.includes('--execute');
}

export function formatDryRunPlan(action: string, plan: ServiceInstallPlan): string {
  const lines = [`# ${action} (dry run — pass --execute to run these commands)`];
  for (const command of plan.commands) {
    lines.push(command);
  }
  return lines.join('\n');
}

export async function executeServicePlan(
  plan: ServiceInstallPlan,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CommandRunResult[]> {
  const results: CommandRunResult[] = [];
  for (const command of plan.commands) {
    const { stdout, stderr, code } = await runner.run(command);
    results.push({ command, stdout, stderr, code });
    if (code !== 0) {
      break;
    }
  }
  return results;
}
