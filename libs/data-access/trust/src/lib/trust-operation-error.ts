import {
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
} from '@trinity/util/matrix';
import { catchError, throwError, type MonoTypeOperatorFunction } from 'rxjs';

/** The recovery action a caller can safely offer for an expected Trust failure. */
export type TrustRecovery =
  | 'none'
  | 'retry'
  | 'reenter-secret'
  | 'open-provider'
  | 'verify-another-device'
  | 'review-security-settings';

/** Stable, secret-safe failure categories across Trust commands. */
export type TrustFailureKind =
  | 'cancelled'
  | 'not-ready'
  | 'invalid-secret'
  | 'recovery-not-configured'
  | 'permission-denied'
  | 'provider-action-required'
  | 'unsupported'
  | 'stale-state'
  | 'partial-update'
  | 'server-failure';

/** One Trust command whose failure can be shown without protocol details. */
export type TrustOperation =
  | 'refresh-health'
  | 'setup'
  | 'recover'
  | 'reset-recovery'
  | 'export-keys'
  | 'import-keys'
  | 'list-devices'
  | 'rename-device'
  | 'delete-device'
  | 'start-verification'
  | 'accept-verification'
  | 'show-qr'
  | 'scan-qr'
  | 'confirm-verification'
  | 'cancel-verification';

/**
 * Expected operational failure from Trust.
 *
 * The object intentionally retains no SDK error, secret, user id, device id, key bytes,
 * passphrase, or homeserver response. Its fields are safe for user diagnostics and
 * telemetry; unexpected causes are collapsed to a secret-safe `server-failure` rather
 * than crossing the capability boundary.
 */
export class TrustOperationError extends Error {
  override readonly name = 'TrustOperationError';

  constructor(
    readonly operation: TrustOperation,
    readonly kind: TrustFailureKind,
    readonly recovery: TrustRecovery,
    message: string,
    readonly partial = false,
  ) {
    super(message);
  }
}

/** Convert a known operational failure without retaining its potentially sensitive cause. */
export function trustOperationFailure(
  operation: TrustOperation,
  cause: unknown,
  partial = false,
): TrustOperationError {
  if (cause instanceof TrustOperationError) {
    return new TrustOperationError(
      operation,
      partial ? 'partial-update' : cause.kind,
      partial ? 'review-security-settings' : cause.recovery,
      partial
        ? 'The Trust change may have completed only partly. Review Security settings before retrying.'
        : cause.message,
      partial || cause.partial,
    );
  }
  if (cause instanceof UiaCancelledError) {
    return new TrustOperationError(
      operation,
      'cancelled',
      'none',
      'The Trust change was cancelled.',
      partial,
    );
  }
  if (cause instanceof UiaUnsupportedError) {
    return new TrustOperationError(
      operation,
      'provider-action-required',
      'open-provider',
      'Your identity provider must complete this Trust change.',
      partial,
    );
  }
  if (cause instanceof UiaAttemptsExceededError) {
    return new TrustOperationError(
      operation,
      'permission-denied',
      'retry',
      'The homeserver did not accept the authentication attempt.',
      partial,
    );
  }
  const errorCode =
    typeof cause === 'object' && cause !== null && 'errcode' in cause
      ? (cause as { readonly errcode?: unknown }).errcode
      : null;
  if (errorCode === 'M_FORBIDDEN') {
    return new TrustOperationError(
      operation,
      'permission-denied',
      'retry',
      'The homeserver refused this Trust change.',
      partial,
    );
  }
  return new TrustOperationError(
    operation,
    partial ? 'partial-update' : 'server-failure',
    partial ? 'review-security-settings' : 'retry',
    partial
      ? 'The Trust change may have completed only partly. Review Security settings before retrying.'
      : 'The homeserver could not complete this Trust change. Try again.',
    partial,
  );
}

/** Map operational errors at a cold command's interface. */
export function recoverTrustOperation<T>(
  operation: TrustOperation,
  options: { readonly partial?: boolean } = {},
): MonoTypeOperatorFunction<T> {
  return (source) =>
    source.pipe(
      catchError((cause: unknown) =>
        throwError(() =>
          trustOperationFailure(operation, cause, options.partial ?? false),
        ),
      ),
    );
}
