import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLogger, formatUnknownError } from '../src/logging.js';

describe('formatUnknownError', () => {
  it('formats Error message with name', () => {
    const err = new TypeError('boom');
    expect(formatUnknownError(err)).toBe('TypeError: boom');
  });

  it('formats ZodError without throwing', () => {
    let zodError: unknown;
    try {
      z.object({ a: z.string() }).parse({});
    } catch (error) {
      zodError = error;
    }
    expect(zodError).toBeInstanceOf(Error);
    const formatted = formatUnknownError(zodError);
    expect(formatted).toContain('ZodError');
    expect(formatted).toContain('Required');
  });

  it('stringifies plain objects', () => {
    expect(formatUnknownError({ code: 1 })).toBe('{"code":1}');
  });
});

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs ZodError in context without crashing console.error (Node 24.11+)', () => {
    let zodError: unknown;
    try {
      z.object({ source: z.object({}) }).parse({});
    } catch (error) {
      zodError = error;
    }

    // On Node 24.11.1–24.13.0, raw console.error(ZodError) throws inside util.inspect.
    // Guard so the suite still passes on fixed Node versions.
    try {
      console.error('raw-zod-probe', zodError);
    } catch (inspectCrash) {
      expect(String(inspectCrash)).toMatch(
        /Cannot read properties of undefined \(reading 'value'\)/,
      );
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger('test.logging');
    expect(() => logger.error('dispatch failed', { error: zodError as Error })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain('dispatch failed');
    expect(line).toContain('ZodError');
    // Must be a single JSON string arg — never the raw Error object.
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
  });
});
