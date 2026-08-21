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
  run [options] -- <shell-command-string>
  logs <job-id> [--follow]
  cancel <job-id> [reason]

rbo run options:
  --json                   Write one final JSON result to stdout (not with --follow)
  --follow                 Stream live logs until the job completes
  --project <path>         Project root (default current directory)
  --cwd <relative-path>    Working directory inside the project
  --shell <shell>          bash|zsh|sh|powershell|pwsh|cmd|direct
  --target-os <os>         Repeatable macos|windows|linux constraint
  --timeout <seconds>      Remote execution timeout, not a CLI wait deadline
  --risk <level>           Job risk level
  --artifact <glob>        Repeatable optional artifact rule
  --queue-policy <policy>  local_fallback|wait|fail_fast

Pass exactly one target-shell command string after \`--\`. Your local shell removes
outer quoting; RBO sends the remaining string unchanged to the target shell. For
example: \`rbo run -- "pnpm test"\`. This is not an argv-safe direct execution API.
For confirmation-required jobs, RBO prompts only from a TTY; non-interactive runs
exit 125 with confirmation instructions. Ctrl+C requests cancellation, waits up to
10 seconds for confirmation, then exits 130.

Environment:
  RBO_CONTROLLER_URL_HTTP   Controller HTTP base (default http://127.0.0.1:7410)
  RBO_DATA_DIR              Controller data dir (default ~/.rbo)
  RBO_AGENT_STATE_DIR       Agent state dir (default ~/.rbo/agent)

See docs/user/getting-started.md for setup.`;
}
