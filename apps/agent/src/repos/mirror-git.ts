import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Keep the launcher embedded so both the Agent package and the CLI bundle can run it.
const LOCKED_GIT_LAUNCHER = `
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdirSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');

const [ownerPath, ...args] = process.argv.slice(1);
const marker = join(ownerPath, process.pid + '-' + randomUUID());

// A reclaimer uses rmdir on the unique owner directory. Either publication
// prevents that removal or removal prevents publication before Git is started.
mkdirSync(marker);

// Keep automatic maintenance inside the Git command's lifetime.
const git = spawn('git', ['-c', 'maintenance.autoDetach=false', '-c', 'gc.autoDetach=false', ...args], {
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});

// The Agent may close its end of this pipe while Git is still writing. Keep
// draining Git's stderr so Git can finish without a live Agent reader.
process.stderr.on('error', () => git.stderr.resume());
git.stderr.pipe(process.stderr, { end: false });
git.on('error', (error) => { process.stderr.write(error.message + '\\n'); });
git.on('close', (code) => {
  rmdirSync(marker);
  process.exitCode = code ?? 1;
});
`;

// All mirror mutations discard stdout. Retain stderr for the existing Git error reporting.
export async function runGitMutation(
  ownerPath: string,
  cwd: string,
  args: string[],
): Promise<void> {
  const command = `git ${args.join(' ')}`;
  await new Promise<void>((resolveCommand, reject) => {
    const launcher = spawn(
      process.execPath,
      ['--input-type=commonjs', '-e', LOCKED_GIT_LAUNCHER, '--', resolve(ownerPath), ...args],
      {
        cwd,
        // Let Git finish if the Agent or its process group shuts down.
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let stderr = '';
    launcher.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      // Continue draining even if diagnostics exceed the capture limit.
      const remaining = 64 * 1024 * 1024 - stderr.length;
      if (remaining > 0) {
        stderr += chunk.slice(0, remaining);
      }
    });
    launcher.on('error', (error) => reject(new Error(`${command} failed: ${error.message}`)));
    launcher.on('close', (code, signal) => {
      if (code === 0) {
        resolveCommand();
      } else {
        reject(new Error(`${command} failed: ${stderr.trim() || `exited with ${signal ?? code}`}`));
      }
    });
  });
}
