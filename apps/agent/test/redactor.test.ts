import { describe, expect, it } from 'vitest';
import { StreamRedactor } from '../src/executor/redactor.js';

describe('StreamRedactor (§29.5 - §29.6)', () => {
  it('redacts simple secret values in a single chunk', () => {
    const redactor = new StreamRedactor(['MY_SECRET_KEY']);
    const output = redactor.redact('log header MY_SECRET_KEY log footer') + redactor.flush();
    expect(output).not.toContain('MY_SECRET_KEY');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts secret values split across two chunk boundaries', () => {
    const redactor = new StreamRedactor(['SUPERSECRETKEY']);
    const chunk1 = redactor.redact('stdout line: SUPERSEC');
    const chunk2 = redactor.redact('RETKEY finished process');
    const final = chunk1 + chunk2 + redactor.flush();

    expect(final).not.toContain('SUPERSECRETKEY');
    expect(final).not.toContain('SUPERSEC');
    expect(final).not.toContain('RETKEY');
    expect(final).toContain('[REDACTED]');
  });

  it('handles empty secrets list without altering output', () => {
    const redactor = new StreamRedactor([]);
    const text = 'normal log line 123';
    expect(redactor.redact(text) + redactor.flush()).toBe(text);
  });

  it('correctly redacts longer secrets before shorter substring secrets regardless of input array order', () => {
    const secrets = ['KEY', 'SUPERSECRETKEY'];
    const redactor = new StreamRedactor(secrets);

    const result = redactor.redact('my_value_SUPERSECRETKEY_end');
    const flushed = redactor.flush();
    const fullOutput = result + flushed;

    expect(fullOutput).toBe('my_value_[REDACTED]_end');
  });
});
