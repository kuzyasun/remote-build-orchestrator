import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Stream a readable body to destPath while enforcing declared size and sha256.
 * Oversized bodies are aborted mid-stream (mirrors Controller artifact upload).
 */
export async function streamDownloadWithLimits(
  source: Readable,
  destPath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const hasher = createHash('sha256');
  const writeStream = createWriteStream(destPath);
  let sizeCounter = 0;
  let limitExceeded = false;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      writeStream.on('finish', () => settle(resolvePromise));
      writeStream.on('close', () => settle(resolvePromise));
      writeStream.on('error', (err) => settle(() => rejectPromise(err)));

      source.on('data', (chunk: Buffer) => {
        if (limitExceeded) {
          return;
        }
        sizeCounter += chunk.length;
        if (sizeCounter > expectedSize) {
          limitExceeded = true;
          source.unpipe(writeStream);
          source.destroy();
          writeStream.destroy();
          // destroy() may not emit finish/error; close settles the write Promise.
          settle(resolvePromise);
          return;
        }
        hasher.update(chunk);
      });

      source.on('error', (err) => settle(() => rejectPromise(err)));
      source.pipe(writeStream);
    });

    if (limitExceeded) {
      await rm(destPath, { force: true });
      throw new Error(`Downloaded size ${sizeCounter} mismatch with expected ${expectedSize}`);
    }

    const sha256 = hasher.digest('hex');
    if (sizeCounter !== expectedSize) {
      await rm(destPath, { force: true });
      throw new Error(`Downloaded size ${sizeCounter} mismatch with expected ${expectedSize}`);
    }
    if (sha256 !== expectedSha256) {
      await rm(destPath, { force: true });
      throw new Error(`Downloaded sha256 ${sha256} mismatch with expected ${expectedSha256}`);
    }
  } catch (err) {
    if (!limitExceeded) {
      await rm(destPath, { force: true });
    }
    throw err;
  }
}
