import {
  type EngineFailure,
  describeMatrixRequestFailure,
} from '@trinity/util/matrix';

/** `request-failed`, with a refresh failure marked as the session's. */
export function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

/** `too-large` for M_TOO_LARGE / 413, else {@link requestFailed} (M_FORBIDDEN as `kind: 'permission'`). */
export function tooLargeOrFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return diagnostic.errcode === 'M_TOO_LARGE' || diagnostic.httpStatus === 413
    ? { kind, code: 'too-large', diagnostic }
    : requestFailed(error);
}
