import { type MonoTypeOperatorFunction, catchError, throwError } from 'rxjs';

export type RoomAdministrationFailure =
  | 'not-signed-in'
  | 'permission-denied'
  | 'invalid-input'
  | 'server-rejected'
  | 'partial-update';

export type RoomAdministrationRecovery =
  | 'sign-in'
  | 'refresh-authority'
  | 'correct-input'
  | 'retry-operation'
  | 'review-room-state';

/** Value-safe failure metadata for a Room Administration command. */
export interface RoomAdministrationRecoveryOutcome {
  readonly kind: 'rejected';
  readonly failure: RoomAdministrationFailure;
  readonly recovery: RoomAdministrationRecovery;
  readonly operation: string;
  /** The server-side step known to have completed before a later step failed. */
  readonly completedStep?: 'media-upload' | 'canonical-address-cleared';
}

/** Typed command error whose metadata never exposes Matrix event or secret content. */
export class RoomAdministrationError extends Error {
  constructor(
    readonly outcome: RoomAdministrationRecoveryOutcome,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RoomAdministrationError';
  }
}

export function roomAdministrationNotSignedIn(
  operation: string,
): RoomAdministrationError {
  return new RoomAdministrationError(
    {
      kind: 'rejected',
      failure: 'not-signed-in',
      recovery: 'sign-in',
      operation,
    },
    'Not signed in.',
  );
}

export function roomAdministrationInvalidInput(
  operation: string,
  message: string,
): RoomAdministrationError {
  return new RoomAdministrationError(
    {
      kind: 'rejected',
      failure: 'invalid-input',
      recovery: 'correct-input',
      operation,
    },
    message,
  );
}

/** Convert a rejected Matrix request into a stable recovery contract. */
export function recoverRoomAdministrationRequest<T>(
  operation: string,
  partial?: {
    readonly completedStep: 'media-upload' | 'canonical-address-cleared';
  },
): MonoTypeOperatorFunction<T> {
  return (source) =>
    source.pipe(
      catchError((cause: unknown) => {
        if (cause instanceof RoomAdministrationError && !partial) {
          return throwError(() => cause);
        }
        return throwError(
          () =>
            new RoomAdministrationError(
              {
                kind: 'rejected',
                failure: partial ? 'partial-update' : 'server-rejected',
                recovery: partial ? 'review-room-state' : 'retry-operation',
                operation,
                ...(partial ?? {}),
              },
              cause instanceof Error
                ? cause.message
                : 'The homeserver rejected the room update.',
              cause,
            ),
        );
      }),
    );
}
