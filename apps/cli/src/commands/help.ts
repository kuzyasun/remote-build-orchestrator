import { RBO_CONTROLLER_VERSION } from '@rbo/shared';

/** Top-level usage text for `rbo --help` / `rbo -h` / `rbo help`. */
export function formatCliHelp(): string {
  return `rbo CLI v${RBO_CONTROLLER_VERSION}

Usage:
  rbo [--help|-h|help] [--version|-v]
  rbo <command> [args]

Commands:
  controller init [--force] [--data-dir <dir>]
  controller fingerprint [--data-dir <dir>]
  controller start [--daemon] [--replace] [--data-dir <dir>]
  controller stop [--data-dir <dir>]
  controller restore <staging-dir> [--data-dir <dir>]

  agent init [--force] [--state-dir <dir>]
  agent start [--daemon] [--replace] [--state-dir <dir>]
  agent stop-process [--state-dir <dir>]
  agent approve <pairing-request-id>
  agent revoke <agent-id>
  agent probe <agent-id>
  agent install|status|stop|uninstall [--execute]
      (OS service plans; process stop is stop-process)

  agents
  doctor [--data-dir <dir>]
  submit <job-request.json>
  logs <job-id> [--follow]
  cancel <job-id> [reason]

Environment:
  RBO_CONTROLLER_URL_HTTP   Controller HTTP base (default http://127.0.0.1:7410)
  RBO_DATA_DIR              Controller data dir (default ~/.rbo)
  RBO_AGENT_STATE_DIR       Agent state dir (default ~/.rbo/agent)

See docs/ops/getting-started.md for setup.`;
}
