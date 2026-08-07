import { ConnectionError, HTTPError, MatrixError } from 'matrix-js-sdk';
import { type MonoTypeOperatorFunction, retry, throwError, timer } from 'rxjs';

// Re-exported because they are this module's implicit public surface: the predicate below
// answers questions *about* these classes, so a caller testing or narrowing against it
// needs the constructors — and nothing outside data-access may import matrix-js-sdk
// itself. Same reasoning as the enum re-export in data-access/rooms' room-settings service.
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
 * True when `err` represents a transient homeserver hiccup worth retrying/quieting:
 * a connection-level failure, or an HTTP/Matrix error that is rate-limited (429) or
 * server-side (5xx). Genuine client errors (4xx except 429), plain `Error`s and
 * `undefined` are NOT transient and must surface as usual.
 *
 * `MatrixError` extends `HTTPError`, so a Matrix error is matched by either arm;
 * both are checked explicitly for clarity.
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
 * RxJS operator that retries the source up to {@link MAX_RETRIES} times on a
 * {@link isTransientMatrixError transient} failure, backing off exponentially.
 * Non-transient errors are rethrown immediately (no retry); after the retries are
 * exhausted the last transient error is rethrown so a downstream `catchError` can
 * still perform its final fallback.
 */
export function retryTransient<T>(): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: MAX_RETRIES,
    delay: (err, attempt) =>
      isTransientMatrixError(err)
        ? timer(backoffMs(attempt))
        : throwError(() => err),
  });
}
