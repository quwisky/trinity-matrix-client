import {
  type EngineFailure,
  describeMatrixRequestFailure,
  engineRequestFailure,
} from '@trinity/util/matrix';

/** `too-large` for M_TOO_LARGE / 413, else {@link engineRequestFailure} (M_FORBIDDEN as `kind: 'permission'`). */
export function tooLargeOrFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return diagnostic.errcode === 'M_TOO_LARGE' || diagnostic.httpStatus === 413
    ? { kind, code: 'too-large', diagnostic }
    : engineRequestFailure(error);
}
