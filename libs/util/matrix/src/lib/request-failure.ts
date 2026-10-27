import { EngineRequestError, engineFailureMessage } from './engine-result';
import {
  ConnectionError,
  HTTPError,
  isMatrixRequestAbortError,
  MatrixError,
} from './transient-errors';

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
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MATRIX_ERRCODE = /^[A-Z][A-Z0-9_.-]{0,127}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** The user-facing text for a failure group; operation fallbacks replace `http` and `unexpected`. */
export function requestFailureMessage(
  kind: MatrixRequestFailureKind,
  {
    retryAfterMs: delay,
    errorName,
  }: Pick<MatrixRequestFailureMetadata, 'retryAfterMs' | 'errorName'> = {},
): string {
  switch (kind) {
    case 'timeout':
      return 'The request timed out. Try again.';
    case 'authentication':
      return 'Your session has expired. Sign in again.';
    case 'network':
      return errorName === 'TokenRefreshError'
        ? 'Your session could not be refreshed. Check your connection and try again.'
        : 'Check your connection and try again.';
    case 'permission':
      return 'You do not have permission to do that.';
    case 'rate-limit': {
      if (delay === undefined) return 'Too many requests. Try again shortly.';
      const seconds = Math.ceil(delay / 1000);
      return `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
    case 'server':
      return 'The homeserver is unavailable. Try again.';
    case 'http':
    case 'unexpected':
      return DEFAULT_MESSAGE;
  }
}

function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === name
  );
}

function safeHttpStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined;
}

function safeErrcode(value: unknown): string | undefined {
  return typeof value === 'string' && MATRIX_ERRCODE.test(value)
    ? value
    : undefined;
}

function retryAfterMs(error: HTTPError): number | undefined {
  if (!error.isRateLimitError()) return undefined;
  try {
    const delay = error.getRetryAfterMs();
    return delay !== null &&
      Number.isFinite(delay) &&
      delay >= 0 &&
      delay <= MAX_RETRY_AFTER_MS
      ? delay
      : undefined;
  } catch {
    return undefined;
  }
}

function isTimeout(error: unknown): boolean {
  if (isMatrixRequestAbortError(error)) return true;
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
  if (
    (kind === 'unexpected' || hasErrorName(error, 'TokenRefreshError')) &&
    error instanceof Error
  ) {
    diagnostic.errorName = ERROR_NAME.test(error.name) ? error.name : 'Error';
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
  if (error instanceof EngineRequestError) {
    // Unrecognised and plain HTTP failures behave like the raw errors they stand for: an
    // operation-specific fallback replaces their message.
    const { failure } = error;
    return {
      kind: failure.kind,
      message:
        (failure.kind === 'unexpected' || failure.kind === 'http') &&
        fallbackMessage !== DEFAULT_MESSAGE
          ? fallbackMessage
          : engineFailureMessage(failure),
      diagnostic: failure.diagnostic,
    };
  }
  if (isTimeout(error)) {
    return failure('timeout', requestFailureMessage('timeout'), error);
  }

  if (hasErrorName(error, 'TokenRefreshLogoutError')) {
    return failure(
      'authentication',
      requestFailureMessage('authentication'),
      error,
    );
  }

  if (hasErrorName(error, 'TokenRefreshError')) {
    return failure(
      'network',
      requestFailureMessage('network', { errorName: 'TokenRefreshError' }),
      error,
    );
  }

  if (error instanceof ConnectionError) {
    return failure('network', requestFailureMessage('network'), error);
  }

  if (error instanceof HTTPError) {
    const httpStatus = safeHttpStatus(error.httpStatus);
    const errcode =
      error instanceof MatrixError ? safeErrcode(error.errcode) : undefined;
    const metadata = {
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errcode ? { errcode } : {}),
    };

    // Matrix also uses HTTP 401 for interactive-auth challenges. Only token-specific
    // errcodes mean the current login has expired.
    if (errcode && TOKEN_ERRORS.has(errcode)) {
      return failure(
        'authentication',
        requestFailureMessage('authentication'),
        error,
        metadata,
      );
    }
    if (httpStatus === 403 || errcode === 'M_FORBIDDEN') {
      return failure(
        'permission',
        requestFailureMessage('permission'),
        error,
        metadata,
      );
    }
    if (error.isRateLimitError()) {
      const delay = retryAfterMs(error);
      return failure(
        'rate-limit',
        requestFailureMessage('rate-limit', { retryAfterMs: delay }),
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
        requestFailureMessage('server'),
        error,
        metadata,
      );
    }
    return failure('http', fallbackMessage, error, metadata);
  }

  // Operation-specific request boundaries deliberately replace unmatched errors:
  // SDK wrapper messages can retain a response body or request URL. Callers that use
  // the default are domain/UI helpers and retain their existing specific validation.
  const message =
    fallbackMessage === DEFAULT_MESSAGE &&
    error instanceof Error &&
    error.message.trim()
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
