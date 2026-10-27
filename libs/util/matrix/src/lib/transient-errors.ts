import { ConnectionError, HTTPError, MatrixError } from 'matrix-js-sdk';
import { type MonoTypeOperatorFunction, retry, throwError, timer } from 'rxjs';

// Re-exported because nothing outside data-access may import matrix-js-sdk, and callers
// testing or narrowing against the predicate below need these constructors.
export { ConnectionError, HTTPError, MatrixError } from 'matrix-js-sdk';

/** How many times a transient failure is retried before giving up. */
const MAX_RETRIES = 3;
/** First backoff step (ms); doubles each attempt up to {@link MAX_BACKOFF_MS}. */
const BASE_BACKOFF_MS = 300;
/** Ceiling for a single backoff delay (ms). */
const MAX_BACKOFF_MS = 3000;

/** Retryable HTTP statuses: rate-limiting (429) and any server-side 5xx. */
function isTransientStatus(status: number | undefined): boolean {
  return status === 429 || (status ?? 0) >= 500;
}

/**
 * Matrix's fetch transport preserves AbortError for both its local request deadline and
 * deliberate cancellation instead of wrapping it in a ConnectionError; neither is an
 * application defect.
 */
export function isMatrixRequestAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'AbortError'
  );
}

/**
 * True when `err` is a transient homeserver hiccup worth retrying/quieting: a
 * connection-level failure, or an HTTP/Matrix error that is rate-limited (429) or
 * server-side (5xx). Client errors (4xx except 429), plain `Error`s and `undefined` are NOT
 * transient and must surface as usual.
 */
export function isTransientMatrixError(err: unknown): boolean {
  if (err instanceof ConnectionError) {
    return true;
  }
  if (err instanceof MatrixError || err instanceof HTTPError) {
    return isTransientStatus(err.httpStatus);
  }
  return false;
}

/** Exponential backoff capped at {@link MAX_BACKOFF_MS}: 300, 600, 1200, ... ms. */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * RxJS operator that retries the source up to {@link MAX_RETRIES} times on a failure
 * `isTransient` accepts (by default a {@link isTransientMatrixError transient} one), backing
 * off exponentially. Other errors
 * are rethrown immediately; once retries are exhausted the last error is rethrown so a
 * downstream `catchError` can fall back.
 */
export function retryTransient<T>(
  isTransient: (err: unknown) => boolean = isTransientMatrixError,
): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: MAX_RETRIES,
    delay: (err, attempt) =>
      isTransient(err) ? timer(backoffMs(attempt)) : throwError(() => err),
  });
}
