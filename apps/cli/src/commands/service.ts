// OS service lifecycle plans for `rbo agent install|status|start|stop|uninstall`
// (§33, §35 Phase 2). Each plan lists the exact commands for the target OS;
// the CLI's install/uninstall handlers execute them. Kept as pure data here so
// they are unit-testable without touching the real service manager.

export type SupportedPlatform = 'win32' | 'darwin' | 'linux';

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
