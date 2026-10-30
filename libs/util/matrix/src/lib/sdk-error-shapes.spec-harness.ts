/**
 * Stand-ins for matrix-js-sdk's request errors, for specs that may not import the SDK. They
 * carry the SDK's fields and rate-limit hooks, so `@trinity/util/matrix` classifies each one
 * like the class it stands for. matrix-client's `sdk-error-classification.spec.ts` checks
 * that against the real classes, and that this file and util/matrix's
 * `sdk-error-shapes.spec-harness.ts` (kept so the kernel library imports nothing) stay
 * identical.
 */

/** The SDK's reading of a `Retry-After` header: seconds or an HTTP date, else it throws. */
function retryAfterHeaderMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (/^\d+$/.test(value)) {
    const ms = Number.parseInt(value, 10) * 1000;
    if (!Number.isFinite(ms)) throw new Error('Retry-After is too large');
    return ms;
  }
  const date = new Date(value);
  if (date.toUTCString() !== value) {
    throw new Error('Retry-After is neither seconds nor an HTTP date');
  }
  return date.getTime() - Date.now();
}

/** A `ConnectionError`: its `name` says so. */
export function connectionError(message = 'fetch failed'): Error {
  return Object.defineProperty(new Error(message), 'name', {
    value: 'ConnectionError',
  });
}

/** An `HTTPError`, optionally with a `Retry-After` header value. */
export function httpError(
  httpStatus: number,
  message = `HTTP ${httpStatus}`,
  retryAfter?: string,
): Error & {
  readonly httpStatus: number;
  isRateLimitError(): boolean;
  getRetryAfterMs(): number | null;
} {
  return Object.assign(new Error(message), {
    httpStatus,
    isRateLimitError: () => httpStatus === 429,
    getRetryAfterMs: () => retryAfterHeaderMs(retryAfter),
  });
}

/**
 * A `MatrixError`: its `name` is its `errcode`, and `data` is the response body, whose
 * `retry_after_ms` counts after any `Retry-After` header.
 */
export function matrixError(
  errcode: string,
  httpStatus?: number,
  data: Readonly<Record<string, unknown>> = {},
  retryAfter?: string,
): Error & {
  readonly httpStatus: number | undefined;
  readonly errcode: string;
  readonly data: Readonly<Record<string, unknown>>;
  isRateLimitError(): boolean;
  getRetryAfterMs(): number | null;
} {
  const text = typeof data['error'] === 'string' ? data['error'] : errcode;
  return Object.assign(new Error(`MatrixError: [${httpStatus}] ${text}`), {
    name: errcode,
    httpStatus,
    errcode,
    data: { errcode, ...data },
    isRateLimitError: () =>
      errcode === 'M_LIMIT_EXCEEDED' ||
      (errcode === 'M_UNKNOWN' && httpStatus === 429),
    getRetryAfterMs: () => {
      const header = retryAfterHeaderMs(retryAfter);
      if (header !== null) return header;
      if (errcode !== 'M_LIMIT_EXCEEDED' || !('retry_after_ms' in data)) {
        return null;
      }
      const delay = data['retry_after_ms'];
      if (!Number.isInteger(delay)) {
        throw new Error('retry_after_ms is not an integer');
      }
      return delay as number;
    },
  });
}
