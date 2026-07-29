import { describe, expect, it } from 'vitest';
import {
  FRAME_TAG_CONTROL,
  FRAME_TAG_STDERR,
  FRAME_TAG_STDOUT,
  WindowsHelperFrameReader,
} from '../src/windows-frames.js';

function encodeFrame(tag: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

describe('WindowsHelperFrameReader', () => {
  it('parses stdout, stderr, and control frames from a byte stream', () => {
    const reader = new WindowsHelperFrameReader();
    const chunk = Buffer.concat([
      encodeFrame(FRAME_TAG_STDOUT, Buffer.from('hello')),
      encodeFrame(FRAME_TAG_STDERR, Buffer.from('warn')),
      encodeFrame(FRAME_TAG_CONTROL, Buffer.from('{"success":true}')),
    ]);

    const frames = reader.append(chunk);
    expect(frames.stdout.map((b) => b.toString())).toEqual(['hello']);
    expect(frames.stderr.map((b) => b.toString())).toEqual(['warn']);
    expect(frames.control?.toString()).toBe('{"success":true}');
  });

  it('buffers partial frames across chunks', () => {
    const reader = new WindowsHelperFrameReader();
    const frame = encodeFrame(FRAME_TAG_STDOUT, Buffer.from('partial'));
    const first = reader.append(frame.subarray(0, 3));
    expect(first.stdout).toHaveLength(0);

    const second = reader.append(frame.subarray(3));
    expect(second.stdout.map((b) => b.toString())).toEqual(['partial']);
  });
});
