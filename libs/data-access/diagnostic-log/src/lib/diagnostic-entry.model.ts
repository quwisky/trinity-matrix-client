/** Levels a diagnostic entry can carry, lowest first. */
export const DIAGNOSTIC_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
] as const;

export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

/**
 * Where an entry came from: matrix-js-sdk's loggers, Trinity's own console warnings and
 * errors, an uncaught error or rejection, or an application lifecycle marker.
 */
export type DiagnosticSource = 'sdk' | 'console' | 'window' | 'app';

/**
 * One stored log line. `message` has already been scrubbed of secrets; Matrix identifiers
 * are kept on the device and replaced only when the file is exported.
 */
export interface DiagnosticEntry {
  readonly ts: number;
  readonly level: DiagnosticLevel;
  readonly source: DiagnosticSource;
  readonly logger: string;
  readonly message: string;
}

/** How much the rolling log keeps; the oldest entries go first. */
export interface DiagnosticLogLimits {
  readonly maxBytes: number;
  readonly maxAgeMs: number;
}

/** About 5 MB and 48 hours. */
export const DIAGNOSTIC_LOG_LIMITS: DiagnosticLogLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxAgeMs: 48 * 60 * 60 * 1000,
};

/** One message's ceiling, so a single huge object cannot take the whole budget. */
export const MAX_MESSAGE_LENGTH = 8 * 1024;

/** Approximate stored size of an entry: its text plus a fixed allowance for the fields. */
export function entrySize(entry: DiagnosticEntry): number {
  return entry.message.length + entry.logger.length + 48;
}
