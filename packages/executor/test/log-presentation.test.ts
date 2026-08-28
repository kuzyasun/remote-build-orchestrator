import { describe, expect, it } from 'vitest';
import { presentLogChunks, presentLogTail } from '../src/log-presentation.js';

const run = (chunks: Buffer[], maxBytes = 1024, extra = {}) =>
  presentLogChunks(chunks, undefined, { maxBytes, ...extra });

describe('log presentation', () => {
  it.each([
    ['TypeScript', 'tsc --noEmit'],
    ['Vitest', 'vitest run'],
    ['Cargo', 'cargo test'],
    ['GCC', 'gcc -Wall'],
    ['ESP-IDF', 'idf.py build'],
    ['Biome', 'biome check'],
  ])('keeps a bounded stderr-first tail for %s fixtures', (tool, command) => {
    const stderr = Buffer.from(
      `${'noise '.repeat(5000)}\nERROR: ${tool} failed while running ${command}\n`,
    );
    const stdout = Buffer.from(
      `progress ${tool}\n\x1b]0;SECRET_TOKEN=fixture-secret\x07finished\n`,
    );
    const result = presentLogTail([stderr.subarray(-16 * 1024)], [stdout], {
      maxBytes: 16 * 1024,
      maxLines: 8,
      stderrPrefixComplete: true,
      stdoutPrefixComplete: true,
    });
    expect(result.length).toBeLessThanOrEqual(16 * 1024);
    expect(result.toString('utf8')).toContain(`ERROR: ${tool} failed`);
    expect(result.toString('utf8')).not.toContain('fixture-secret');
    expect(result.includes(0x1b)).toBe(false);
    expect(result.includes(0x07)).toBe(false);
    expect(result.toString('utf8')).not.toContain('\ufffd');
  });

  it('retains an error sentinel and never splits a UTF-8 scalar at the cap', () => {
    const result = presentLogTail(
      [Buffer.from(`${'é'.repeat(20_000)}\nERROR: sentinel\n`).subarray(-16 * 1024)],
      [Buffer.from('stdout\n')],
      {
        maxBytes: 16 * 1024,
        maxLines: 1000,
        stderrPrefixComplete: true,
        stdoutPrefixComplete: true,
      },
    );
    expect(result.toString('utf8')).toContain('ERROR: sentinel');
    expect(result.toString('utf8')).not.toContain('\ufffd');
    expect(result.length).toBeLessThanOrEqual(16 * 1024);
  });

  it.each([
    ['OSC', 'SECRET_TOKEN=osc-payload'],
    ['CSI', '31mSECRET_TOKEN=csi-payload'],
  ])('omits a stream whose bounded suffix starts inside %s', (_kind, payload) => {
    const result = presentLogTail([Buffer.from(payload)], [Buffer.from('safe stdout\n')], {
      maxBytes: 16 * 1024,
      maxLines: 8,
      stderrPrefixComplete: false,
      stdoutPrefixComplete: true,
    });
    expect(result.toString('utf8')).toBe('safe stdout\n');
    expect(result.toString('utf8')).not.toContain('SECRET_TOKEN');
    expect(result.toString('utf8')).not.toContain('\ufffd');
  });

  it('keeps the last newline-terminated line when maxLines is 1', () => {
    const result = presentLogTail([Buffer.from('noise\nERROR: last\n')], [], {
      maxBytes: 1024,
      maxLines: 1,
      stderrPrefixComplete: true,
      stdoutPrefixComplete: true,
    });
    expect(result.toString('utf8')).toBe('ERROR: last\n');
  });

  it('returns N trailing records for newline-terminated logs', () => {
    const two = presentLogTail([Buffer.from('a\nb\nc\n')], [], {
      maxBytes: 1024,
      maxLines: 2,
      stderrPrefixComplete: true,
      stdoutPrefixComplete: true,
    });
    expect(two.toString('utf8')).toBe('b\nc\n');
    const unterminated = presentLogTail([Buffer.from('a\nb\nc')], [], {
      maxBytes: 1024,
      maxLines: 1,
      stderrPrefixComplete: true,
      stdoutPrefixComplete: true,
    });
    expect(unterminated.toString('utf8')).toBe('c');
  });

  it('strips CSI and OSC across chunk boundaries', () => {
    const a = run([
      Buffer.from('ok\x1b[31'),
      Buffer.from('mred\x1b]8;;https://x'),
      Buffer.from('\x07link\x1b]8;;\x07 done\n'),
    ]);
    expect(a.data.toString()).toBe('okredlink done\n');
    expect(a.state.mode).toBe('ground');
  });

  it('retains malformed escape follow-up text and serializable bounded state', () => {
    const a = run([Buffer.from('a\x1bXb')]);
    expect(a.data.toString()).toBe('aXb');
    const split = run([Buffer.from('a\x1b]title')]);
    expect(split.data.toString()).toBe('a');
    expect(JSON.stringify(split.state).length).toBeLessThan(200);
    expect(split.state).not.toHaveProperty('payload');
  });

  it('never splits UTF-8 and enforces the budget', () => {
    const result = run([Buffer.from([0xf0, 0x9f]), Buffer.from([0x98, 0x80, 0x61, 0x62, 0x63])], 4);
    expect(result.data.toString()).toBe('😀');
    expect(Buffer.byteLength(result.data)).toBe(4);
  });

  it('resumes a split control sequence from serializable parser state', () => {
    const first = run([Buffer.from('left\x1b[3')]);
    const second = presentLogChunks([Buffer.from('1mright')], first.state, { maxBytes: 1024 });
    expect(second.data.toString()).toBe('right');
  });

  it('collapses exact consecutive lines only within a page', () => {
    const result = run([Buffer.from('same\nsame\ndifferent\nsame\n')], 1024, {
      collapseDuplicates: true,
    });
    expect(result.data.toString()).toBe('same\ndifferent\nsame\n');
  });

  it('stops scanning controls at the bounded raw cap', () => {
    const result = run([Buffer.concat([Buffer.from('\x1b]'), Buffer.alloc(100, 0x61)])], 4, {
      rawScanCap: 32,
    });
    expect(result.truncated).toBe(true);
    expect(result.scannedRawBytes).toBe(32);
  });

  it('rejects budgets below four bytes', () => {
    for (const budget of [1, 2, 3]) {
      expect(() => run([Buffer.from('x')], budget)).toThrow(/at least 4/);
    }
    expect(run([Buffer.from('1234')], 4).data.toString()).toBe('1234');
  });

  it('rolls back an incomplete dedup line when a raw or output cap is reached', () => {
    const raw = run([Buffer.from('same\nsame')], 1024, {
      collapseDuplicates: true,
      rawScanCap: 8,
    });
    expect(raw.data.toString()).toBe('same\n');
    expect(raw.consumedRawBytes).toBe(5);
    const output = run([Buffer.from('same\nsame')], 8, { collapseDuplicates: true });
    expect(output.data.toString()).toBe('same\n');
    expect(output.consumedRawBytes).toBe(5);
  });

  it('does not consume a scalar that would cross the raw scan cap', () => {
    const result = run([Buffer.from([0x78, 0xf0, 0x9f]), Buffer.from([0x98, 0x80])], 1024, {
      rawScanCap: 2,
    });
    expect(result.data.toString()).toBe('x');
    expect(result.consumedRawBytes).toBe(1);
    expect(result.scannedRawBytes).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
