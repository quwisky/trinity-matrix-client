import { MAX_MESSAGE_LENGTH } from '../diagnostic-entry.model';
import { REDACTED } from '../scrub-secrets';

/**
 * Cut a message to {@link MAX_MESSAGE_LENGTH}, saying how much was cut. Only ever applied to
 * text that `scrubMessage` has already scrubbed, so a cut can't leave part of a secret.
 */
export function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  const cut = text.length - MAX_MESSAGE_LENGTH;
  return `${text.slice(0, MAX_MESSAGE_LENGTH)}… [${cut} characters truncated]`;
}

/**
 * Render console-style arguments as one line of text, the way the console would show
 * them. Binary values become their length only: key material reaches loggers as typed
 * arrays, and their bytes must never be stored. A value that throws while being formatted
 * becomes `<redacted>` (fail closed). The result is neither scrubbed nor cut to length:
 * `DiagnosticLogService` scrubs it, then truncates.
 */
export function formatLogArgs(args: readonly unknown[]): string {
  return args.map(formatSafely).join(' ');
}

function formatSafely(value: unknown): string {
  try {
    return formatValue(value);
  } catch {
    return REDACTED;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (isBinary(value)) {
    return binaryLabel(value);
  }
  if (typeof value === 'function') {
    return `[function ${value.name || 'anonymous'}]`;
  }
  if (typeof value !== 'object' || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value, safeReplacer()) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function binaryLabel(value: ArrayBuffer | ArrayBufferView): string {
  return `[binary ${value.byteLength} bytes]`;
}

function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (isBinary(value)) {
      return binaryLabel(value);
    }
    if (value instanceof Error) {
      return value.stack ?? `${value.name}: ${value.message}`;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[circular]';
      }
      seen.add(value);
    }
    return value;
  };
}
