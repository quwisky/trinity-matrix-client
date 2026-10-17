import { Observable, throwError } from 'rxjs';
import { describeMatrixRequestFailure } from '@trinity/util/matrix';

export type PersistedAccountStartOutcome =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'failed';
      readonly failure:
        | 'reauthentication-required'
        | 'transient-network'
        | 'crypto-failure'
        | 'crypto-store-key-lost'
        | 'secure-storage-unavailable';
    };

export type PersistedAccountStartFailure = Extract<
  PersistedAccountStartOutcome,
  { kind: 'failed' }
>['failure'];

export class MatrixClientStartupError extends Error {
  constructor(
    readonly failure: PersistedAccountStartFailure,
    readonly original: unknown,
  ) {
    super(`Matrix Account startup failed: ${failure}`);
  }
}

export function expectedClientStartFailure(
  error: unknown,
): PersistedAccountStartFailure | null {
  const candidate = isRecord(error) ? error : {};
  const data = isRecord(candidate['data']) ? candidate['data'] : {};
  const errcode =
    typeof candidate['errcode'] === 'string'
      ? candidate['errcode']
      : typeof data['errcode'] === 'string'
        ? data['errcode']
        : null;
  if (errcode === 'M_UNKNOWN_TOKEN' || errcode === 'M_MISSING_TOKEN') {
    return 'reauthentication-required';
  }
  const described = describeMatrixRequestFailure(error).kind;
  if (described === 'authentication') {
    return 'reauthentication-required';
  }
  if (
    described === 'network' ||
    described === 'timeout' ||
    described === 'rate-limit' ||
    described === 'server'
  ) {
    return 'transient-network';
  }
  const status =
    typeof candidate['httpStatus'] === 'number'
      ? candidate['httpStatus']
      : null;
  const transientStatus =
    status === 0 ||
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500);
  const transientName =
    candidate['name'] === 'AbortError' || candidate['name'] === 'TimeoutError';
  return transientStatus || transientName ? 'transient-network' : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function classifyCryptoStartupFailure(
  error: unknown,
): Observable<never> {
  return throwError(
    () => new MatrixClientStartupError('crypto-failure', error),
  );
}
