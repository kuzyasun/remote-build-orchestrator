import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Stream a readable body to destPath while enforcing declared size and sha256.
 * Oversized bodies are aborted mid-stream (mirrors Controller artifact upload).
 */
export async function streamDownloadWithLimits(
  source: Readable,
  destPath: string,
  expectedSize: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const hasher = createHash('sha256');
  let sizeCounter = 0;
  const sizeError = () =>
    new Error(`Downloaded size ${sizeCounter} mismatch with expected ${expectedSize}`);
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeCounter += chunk.length;
      if (sizeCounter > expectedSize) {
        callback(sizeError());
        return;
      }
      hasher.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, verify, createWriteStream(destPath), { signal });
    if (sizeCounter !== expectedSize) {
      throw sizeError();
    }
    const sha256 = hasher.digest('hex');
    if (sha256 !== expectedSha256) {
      throw new Error(`Downloaded sha256 ${sha256} mismatch with expected ${expectedSha256}`);
    }
  } catch (err) {
    await rm(destPath, { force: true });
    throw err;
  }
}
