export class StreamRedactor {
  private secrets: string[];
  private tailBuffer = '';
  private maxSecretLength: number;

  constructor(secrets: string[]) {
    // Only redact non-empty secret values, sorted by length descending so longer secrets take precedence
    this.secrets = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
    this.maxSecretLength = this.secrets.reduce((max, s) => Math.max(max, s.length), 0);
  }

  public redact(chunk: string): string {
    if (this.secrets.length === 0) {
      return chunk;
    }

    const combined = this.tailBuffer + chunk;
    let redacted = combined;

    for (const secret of this.secrets) {
      if (redacted.includes(secret)) {
        redacted = redacted.split(secret).join('[REDACTED]');
      }
    }

    if (this.maxSecretLength <= 1) {
      this.tailBuffer = '';
      return redacted;
    }

    // Keep tail buffer for split secrets
    const keepLength = Math.min(this.maxSecretLength - 1, redacted.length);
    const outputLength = redacted.length - keepLength;

    this.tailBuffer = redacted.slice(outputLength);
    return redacted.slice(0, outputLength);
  }

  public flush(): string {
    if (this.secrets.length === 0 || this.tailBuffer.length === 0) {
      const remaining = this.tailBuffer;
      this.tailBuffer = '';
      return remaining;
    }

    let redacted = this.tailBuffer;
    for (const secret of this.secrets) {
      if (redacted.includes(secret)) {
        redacted = redacted.split(secret).join('[REDACTED]');
      }
    }

    this.tailBuffer = '';
    return redacted;
  }
}
