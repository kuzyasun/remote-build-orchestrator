import { execFile } from 'node:child_process';
import { basename, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { describeWindowsExecutorResolution } from '@rbo/executor';

const execFileAsync = promisify(execFile);

// POSIX resolves relative names against the OS's cwd directory reference even if
// its original pathname is renamed. Isolate cwd in a child so concurrent requests
// cannot change it, and keep its program inline for the single-file CLI bundle.
const posixPublish = String.raw`
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rename, stat, unlink } from 'node:fs/promises';

async function publish() {
  const [parent, device, inode, sourcePath, destination, sha256, overwrite] = process.argv.slice(1);
  const identity = await stat('.', { bigint: true });
  if (process.cwd() !== parent || String(identity.dev) !== device || String(identity.ino) !== inode) {
    throw new Error('Destination parent directory changed before materialization');
  }

  const stagePath = '.rbo-artifact-' + randomUUID();
  const source = await open(sourcePath, 'r');
  try {
    const stage = await open(stagePath, 'wx', 0o600);
    try {
      const { mode } = await source.stat();
      const hash = createHash('sha256');
      for await (const chunk of source.createReadStream()) {
        await stage.writeFile(chunk);
        hash.update(chunk);
      }
      if (hash.digest('hex') !== sha256) {
        throw new Error('Stored artifact hash mismatch');
      }
      await stage.chmod(mode & 0o777);
      const stagedIdentity = await stage.stat({ bigint: true });
      if (overwrite === 'true') {
        await rename(stagePath, destination);
      } else {
        await link(stagePath, destination);
      }
      // A local writer can change entries inside the destination directory.
      // Report success only if its name still identifies the verified file.
      const publishedIdentity = await lstat(destination, { bigint: true });
      if (publishedIdentity.dev !== stagedIdentity.dev || publishedIdentity.ino !== stagedIdentity.ino) {
        throw new Error('Destination changed during materialization');
      }
    } finally {
      await stage.close();
      await unlink(stagePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } catch (error) {
    if (error.code === 'EEXIST' && error.syscall === 'link') {
      throw new Error('Destination exists and overwrite=false', { cause: error });
    }
    throw error;
  } finally {
    await source.close();
  }
}

await publish().catch((error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
`;

interface ArtifactPublication {
  parentPath: string;
  parentIdentity: { dev: bigint; ino: bigint };
  sourcePath: string;
  destinationName: string;
  sha256: string;
  overwrite: boolean;
}

export async function publishPosixArtifact(input: ArtifactPublication): Promise<void> {
  const { destinationName } = input;
  if (
    !destinationName ||
    destinationName === '.' ||
    destinationName === '..' ||
    basename(destinationName) !== destinationName
  ) {
    throw new Error('Destination must name a file');
  }
  try {
    await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        posixPublish,
        '--',
        input.parentPath,
        String(input.parentIdentity.dev),
        String(input.parentIdentity.ino),
        resolve(input.sourcePath),
        input.destinationName,
        input.sha256,
        String(input.overwrite),
      ],
      { cwd: input.parentPath, env: {}, windowsHide: true },
    );
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    if (stderr?.trim()) {
      throw new Error(stderr.trim(), { cause: error });
    }
    throw error;
  }
}

export async function publishWindowsArtifact(input: ArtifactPublication): Promise<void> {
  const helper = describeWindowsExecutorResolution();
  if (!helper.path) {
    throw new Error(
      `Windows artifact materialization requires the RBO Windows helper. ${helper.detail}`,
    );
  }

  const publication = execFileAsync(helper.path, ['--publish-artifact-v1'], { windowsHide: true });
  // A legacy helper ignores argv and treats stdin as a job request. This JSON line
  // deliberately has none of the job fields, so the legacy helper rejects and exits.
  publication.child.stdin?.on('error', () => {});
  publication.child.stdin?.end(
    `${JSON.stringify({
      parent_path: win32.toNamespacedPath(input.parentPath),
      parent_device: String(input.parentIdentity.dev),
      parent_inode: String(input.parentIdentity.ino),
      source_path: resolve(input.sourcePath),
      destination_name: input.destinationName,
      sha256: input.sha256,
      overwrite: input.overwrite,
    })}\n`,
  );

  const unsupported =
    'Windows artifact materialization requires an RBO Windows helper with artifact publication v1. Update the helper or set RBO_WINDOWS_EXECUTOR to a compatible executable.';
  let result: { stdout: string };
  try {
    result = await publication;
  } catch (error) {
    const { code, stderr } = error as { code?: number | string; stderr?: string };
    if (code === 2) {
      throw new Error(unsupported, { cause: error });
    }
    if (code === 1 && stderr?.trim()) {
      throw new Error(stderr.trim(), { cause: error });
    }
    throw new Error(`Could not run the RBO Windows artifact publication helper at ${helper.path}`, {
      cause: error,
    });
  }
  if (result.stdout.trim() !== 'rbo-artifact-publication-v1') {
    throw new Error(unsupported);
  }
}
