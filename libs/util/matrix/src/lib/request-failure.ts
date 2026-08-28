import { ConnectionError, HTTPError, MatrixError } from './transient-errors';

/** Stable failure groups used for user messages and privacy-safe diagnostics. */
export type MatrixRequestFailureKind =
  | 'network'
  | 'timeout'
  | 'authentication'
  | 'permission'
  | 'rate-limit'
  | 'server'
  | 'http'
  | 'unexpected';

/** Allowlisted metadata that is safe to write to a diagnostic log. */
export interface MatrixRequestFailureMetadata {
  kind: MatrixRequestFailureKind;
  httpStatus?: number;
  errcode?: string;
  retryAfterMs?: number;
  errorName?: string;
}

/** A user-facing request failure paired with privacy-safe diagnostic metadata. */
export interface MatrixRequestFailure {
  kind: MatrixRequestFailureKind;
  message: string;
  diagnostic: MatrixRequestFailureMetadata;
}

/** Diagnostic context plus allowlisted failure metadata. */
export interface MatrixRequestFailureDiagnostic extends MatrixRequestFailureMetadata {
  operation: string;
}

/** Sink used by {@link reportMatrixRequestFailure}; injectable for tests. */
export type MatrixRequestFailureLogger = (
  message: string,
  diagnostic: MatrixRequestFailureDiagnostic,
) => void;

/** Structural error hooks accepted by request-state helpers such as `runWithBusy`. */
export interface MatrixRequestErrorHandling {
  formatError: (error: unknown) => string;
  reportError: (error: unknown) => void;
}

const DEFAULT_MESSAGE = 'Something went wrong. Try again.';
const TOKEN_ERRORS = new Set(['M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN']);

function retryAfterMs(error: HTTPError): number | undefined {
  if (!error.isRateLimitError()) return undefined;
  try {
    const delay = error.getRetryAfterMs();
    return delay !== null && Number.isFinite(delay) && delay >= 0
      ? delay
      : undefined;
  } catch {
    return undefined;
  }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TimeoutError' ||
    (error instanceof ConnectionError &&
      /timed?\s*out|timeout/i.test(error.message))
  );
}

function failure(
  kind: MatrixRequestFailureKind,
  message: string,
  error: unknown,
  extra: Partial<MatrixRequestFailureMetadata> = {},
): MatrixRequestFailure {
  const diagnostic: MatrixRequestFailureMetadata = { kind, ...extra };
  if (kind === 'unexpected' && error instanceof Error) {
    diagnostic.errorName = error.name || 'Error';
  }
  return { kind, message, diagnostic };
}

/**
 * Convert Matrix SDK and browser request errors into consistent, actionable text.
 * Raw HTTP/Matrix messages are deliberately not returned because they can contain
 * request URLs, server response bodies, or other sensitive details. Plain domain
 * errors retain their existing message so non-network validation remains specific.
 */
export function describeMatrixRequestFailure(
  error: unknown,
  fallbackMessage = DEFAULT_MESSAGE,
): MatrixRequestFailure {
  if (isTimeout(error)) {
    return failure('timeout', 'The request timed out. Try again.', error);
  }

  if (error instanceof ConnectionError) {
    return failure('network', 'Check your connection and try again.', error);
  }

  if (error instanceof HTTPError) {
    const httpStatus = error.httpStatus;
    const errcode = error instanceof MatrixError ? error.errcode : undefined;
    const metadata = {
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errcode ? { errcode } : {}),
    };

    // Matrix also uses HTTP 401 for interactive-auth challenges. Only token-specific
    // errcodes mean the current login has expired.
    if (errcode && TOKEN_ERRORS.has(errcode)) {
      return failure(
        'authentication',
        'Your session has expired. Sign in again.',
        error,
        metadata,
      );
    }
    if (httpStatus === 403 || errcode === 'M_FORBIDDEN') {
      return failure(
        'permission',
        'You do not have permission to do that.',
        error,
        metadata,
      );
    }
    if (error.isRateLimitError()) {
      const delay = retryAfterMs(error);
      const seconds = delay === undefined ? undefined : Math.ceil(delay / 1000);
      return failure(
        'rate-limit',
        seconds === undefined
          ? 'Too many requests. Try again shortly.'
          : `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
        error,
        {
          ...metadata,
          ...(delay !== undefined ? { retryAfterMs: delay } : {}),
        },
      );
    }
    if ((httpStatus ?? 0) >= 500) {
      return failure(
        'server',
        'The homeserver is unavailable. Try again.',
        error,
        metadata,
      );
    }
    return failure('http', fallbackMessage, error, metadata);
  }

  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : fallbackMessage;
  return failure('unexpected', message, error);
}

/** Build an exact, allowlisted log payload without retaining the raw error object. */
export function matrixRequestFailureDiagnostic(
  operation: string,
  error: unknown,
): MatrixRequestFailureDiagnostic {
  return {
    operation,
    ...describeMatrixRequestFailure(error).diagnostic,
  };
}

/** Log a failed operation without passing the raw error across the logging boundary. */
export function reportMatrixRequestFailure(
  operation: string,
  error: unknown,
  logger: MatrixRequestFailureLogger = console.warn,
): void {
  logger(
    '[trinity] Matrix request failed',
    matrixRequestFailureDiagnostic(operation, error),
  );
}

/** Build consistent UI and logging hooks for one named Matrix operation. */
export function matrixRequestErrorHandling(
  operation: string,
  fallbackMessage = DEFAULT_MESSAGE,
  logger: MatrixRequestFailureLogger = console.warn,
): MatrixRequestErrorHandling {
  return {
    formatError: (error) =>
      describeMatrixRequestFailure(error, fallbackMessage).message,
    reportError: (error) =>
      reportMatrixRequestFailure(operation, error, logger),
  };
}
