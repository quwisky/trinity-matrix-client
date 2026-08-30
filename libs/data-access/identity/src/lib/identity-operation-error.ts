import { catchError, throwError, type MonoTypeOperatorFunction } from 'rxjs';

export type IdentityRecovery = 'none' | 'retry';

/** Stable, user-safe Identity failure categories. */
export type IdentityFailureKind =
  'not-ready' | 'offline' | 'unavailable' | 'server-failure';

export type IdentityOperation =
  | 'load-own-profile'
  | 'lookup-user'
  | 'search-users'
  | 'set-display-name'
  | 'set-avatar'
  | 'set-presence'
  | 'ignore-user'
  | 'unignore-user';

/** Operational failure that retains no SDK response, Account, user, or media bytes. */
export class IdentityOperationError extends Error {
  override readonly name = 'IdentityOperationError';

  constructor(
    readonly operation: IdentityOperation,
    readonly kind: IdentityFailureKind,
    readonly recovery: IdentityRecovery,
    message: string,
  ) {
    super(message);
  }
}

export function identityOperationFailure(
  operation: IdentityOperation,
  cause: unknown,
): IdentityOperationError {
  if (cause instanceof IdentityOperationError) {
    return new IdentityOperationError(
      operation,
      cause.kind,
      cause.recovery,
      cause.message,
    );
  }
  if (cause instanceof TypeError) {
    return new IdentityOperationError(
      operation,
      'offline',
      'retry',
      'Identity information is unavailable while this device is offline.',
    );
  }
  const errorCode =
    typeof cause === 'object' && cause !== null && 'errcode' in cause
      ? (cause as { readonly errcode?: unknown }).errcode
      : null;
  if (
    errorCode === 'M_UNRECOGNIZED' ||
    errorCode === 'M_UNSUPPORTED_ROOM_VERSION'
  ) {
    return new IdentityOperationError(
      operation,
      'unavailable',
      'none',
      'This Identity operation is not available on the homeserver.',
    );
  }
  return new IdentityOperationError(
    operation,
    'server-failure',
    'retry',
    'The homeserver could not complete this Identity operation. Try again.',
  );
}

export function recoverIdentityOperation<T>(
  operation: IdentityOperation,
): MonoTypeOperatorFunction<T> {
  return (source) =>
    source.pipe(
      catchError((cause: unknown) =>
        throwError(() => identityOperationFailure(operation, cause)),
      ),
    );
}

export function identityNotReady(
  operation: IdentityOperation,
): IdentityOperationError {
  return new IdentityOperationError(
    operation,
    'not-ready',
    'retry',
    'Identity is not ready for an active Account yet.',
  );
}
