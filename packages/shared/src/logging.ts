export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Serialize unknown failures for logs without calling util.inspect / console on the
 * raw value. Node.js 24.11.1+ can crash inside util.inspect when formatting ZodError
 * (and similar Error objects with inherited `errors` getters).
 */
export function formatUnknownError(error: unknown): string {
  if (error == null) {
    return String(error);
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    const message = error.message || String(error);
    return `${name}${message}`;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

function sanitizeLogContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = value instanceof Error ? formatUnknownError(value) : value;
  }
  return out;
}

export function createLogger(moduleName: string): Logger {
  const log = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    const safeContext = sanitizeLogContext(context);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: moduleName,
      message,
      ...(safeContext ? { context: safeContext } : {}),
    };
    // Always emit pre-serialized JSON — never pass exotic Error objects to console.*.
    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
  };
}
