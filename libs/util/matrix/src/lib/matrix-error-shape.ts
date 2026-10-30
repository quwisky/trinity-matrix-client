// Not exported from the barrel: the shared shape tests for the two classifiers.

/** matrix-js-sdk's `HTTPError` or its `MatrixError` subclass, read by shape. */
export interface MatrixHttpErrorShape extends Error {
  readonly httpStatus?: number;
  readonly errcode?: unknown;
  isRateLimitError?(): boolean;
  getRetryAfterMs?(): number | null;
}

/** matrix-js-sdk's `ConnectionError`, whose `name` getter says so. */
export function isMatrixConnectionError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'ConnectionError';
}

/**
 * matrix-js-sdk's `HTTPError` or `MatrixError`: both own `httpStatus`, even when it is unset.
 * The SDK classes are not imported here; matrix-client's parity spec runs the real ones.
 */
export function isMatrixHttpError(err: unknown): err is MatrixHttpErrorShape {
  return err instanceof Error && 'httpStatus' in err;
}
