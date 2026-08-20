import { describe, expect, it } from 'vitest';
import { presentLogChunks } from '../src/log-presentation.js';

const run = (chunks: Buffer[], maxBytes = 1024, extra = {}) =>
  presentLogChunks(chunks, undefined, { maxBytes, ...extra });

describe('log presentation', () => {
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
