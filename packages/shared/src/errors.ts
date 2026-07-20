import { z } from 'zod';

/**
 * Canonical Zod enum for error categories (§30).
 * Single source of truth — the TS type is derived from this.
 */
export const ErrorCategorySchema = z.enum([
  'validation',
  'no_matching_agent',
  'no_capacity',
  'source_scan',
  'secret_blocked',
  'repo_clone',
  'repo_fetch',
  'base_commit_missing',
  'bundle_import',
  'snapshot_transfer',
  'snapshot_hash',
  'materialization',
  'shell_missing',
  'process_spawn',
  'process_exit',
  'timeout',
  'cancelled',
  'agent_lost',
  'artifact_collection',
  'artifact_upload',
  'cleanup',
  'internal',
]);

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export interface StructuredErrorDetails {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class RboError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RboError';
    this.category = category;
    this.retryable = retryable;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static validation(message: string, details?: Record<string, unknown>): RboError {
    return new RboError('validation', message, false, details);
  }

  static noMatchingAgent(message: string, details?: Record<string, unknown>): RboError {
    return new RboError('no_matching_agent', message, true, details);
  }

  static timeout(message: string, details?: Record<string, unknown>): RboError {
    return new RboError('timeout', message, true, details);
  }

  static internal(message: string, details?: Record<string, unknown>): RboError {
    return new RboError('internal', message, false, details);
  }

  toJSON(): StructuredErrorDetails {
    return {
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
