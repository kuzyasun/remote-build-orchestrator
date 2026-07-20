export const FRAME_TAG_STDOUT = 0x01;
export const FRAME_TAG_STDERR = 0x02;
export const FRAME_TAG_CONTROL = 0x03;

export interface ParsedFrames {
  stdout: Buffer[];
  stderr: Buffer[];
  control?: Buffer;
}

export class WindowsHelperFrameReader {
  private buffer = Buffer.alloc(0);

  append(chunk: Buffer): ParsedFrames {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let control: Buffer | undefined;

    while (this.buffer.length >= 5) {
      const tag = this.buffer[0];
      const length = this.buffer.readUInt32LE(1);
      if (this.buffer.length < 5 + length) {
        break;
      }
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);

      if (tag === FRAME_TAG_STDOUT) {
        stdout.push(payload);
      } else if (tag === FRAME_TAG_STDERR) {
        stderr.push(payload);
      } else if (tag === FRAME_TAG_CONTROL) {
        control = payload;
      }
    }

    return { stdout, stderr, control };
  }
}
