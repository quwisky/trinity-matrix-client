import { Injectable, inject } from '@angular/core';
import {
  MatrixClientService,
  type ServerLogoutHold,
} from '@trinity/data-access/matrix-client';
import {
  MatrixError,
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
  describeMatrixRequestFailure,
  driveUia,
  type UiaPasswordPrompt,
} from '@trinity/util/matrix';
import {
  Observable,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
} from 'rxjs';
import { AccountRuntimeService } from './account-runtime.service';
import type { AccountSignOutOutcome } from './account-runtime.models';

/** The re-authentication answers the person gives while an account is being deleted. */
export interface AccountDeletionStages {
  readonly password: UiaPasswordPrompt;
  /** Resolves true once the person reports the fallback page finished, false to go back. */
  readonly confirmInBrowser: (step: {
    readonly url: string;
    readonly pending: boolean;
  }) => Promise<boolean>;
}

export interface AccountDeletionRequest {
  readonly accountId: string;
  readonly erase: boolean;
  readonly stages: AccountDeletionStages;
}

/** Why an account was not deleted. */
export type AccountDeletionRefusal =
  | 'cancelled'
  | 'attempts-exceeded'
  | 'no-usable-stage'
  | 'unsupported'
  | 'forbidden'
  | 'rate-limited'
  | 'unreachable'
  | 'still-active'
  | 'busy'
  | 'account-unavailable'
  | 'failed';

export type AccountDeletionResult =
  | {
      readonly kind: 'deleted';
      readonly accountId: string;
      readonly cleanup: AccountSignOutOutcome;
    }
  | {
      readonly kind: 'kept';
      readonly accountId: string;
      readonly reason: AccountDeletionRefusal;
      readonly retryAfterMs?: number;
    }
  /** The server may or may not have deleted it; asking again can settle it. */
  | { readonly kind: 'unconfirmed'; readonly accountId: string };

type ServerAnswer =
  | { readonly kind: 'deleted' }
  | {
      readonly kind: 'kept';
      readonly reason: AccountDeletionRefusal;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: 'unconfirmed' };

/**
 * Deletes one explicit account on its homeserver (`POST /account/deactivate` with UIA),
 * then removes it from this device. The server's hard-logout wipe is held for the whole
 * request, because deactivation revokes the token every other request is using.
 */
@Injectable({ providedIn: 'root' })
export class AccountDeletionWorkflow {
  private readonly matrix = inject(MatrixClientService);
  private readonly accounts = inject(AccountRuntimeService);

  delete(request: AccountDeletionRequest): Observable<AccountDeletionResult> {
    return defer(() => {
      const { accountId } = request;
      if (this.accounts.deletionBlocker()) {
        return of(kept(accountId, 'busy'));
      }
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return of(kept(accountId, 'account-unavailable'));
      }
      const hold = this.matrix.holdServerLogout(accountId);
      let authenticated = false;
      const sent = driveUia(
        (auth) => {
          authenticated ||= auth !== null;
          return client.deactivateAccount(auth ?? undefined, request.erase);
        },
        {
          password: { user: accountId, prompt: request.stages.password },
          fallback: ({ stage, session, pending }) =>
            request.stages.confirmInBrowser({
              url: client.getFallbackAuthUrl(stage, session),
              pending,
            }),
        },
      );
      return from(sent).pipe(
        map((): ServerAnswer => ({ kind: 'deleted' })),
        catchError((err: unknown) =>
          this.classify(err, accountId, hold, authenticated),
        ),
        switchMap((answer) => this.settle(accountId, hold, answer)),
      );
    });
  }

  /** Ask the server whether the account still exists, and clean up when it does not. */
  checkDeletion(accountId: string): Observable<AccountDeletionResult> {
    return defer(() => {
      const hold = this.matrix.holdServerLogout(accountId);
      return this.resolveUnknown(accountId, hold, true).pipe(
        switchMap((answer) => this.settle(accountId, hold, answer)),
      );
    });
  }

  /** Clean up an account whose deletion is already known, such as at its provider. */
  removeDeleted(accountId: string): Observable<AccountDeletionResult> {
    return this.accounts
      .removeDeletedAccount(accountId)
      .pipe(
        map((cleanup) => ({ kind: 'deleted', accountId, cleanup }) as const),
      );
  }

  private classify(
    err: unknown,
    accountId: string,
    hold: ServerLogoutHold,
    authenticated: boolean,
  ): Observable<ServerAnswer> {
    if (err instanceof UiaCancelledError) return of(refused('cancelled'));
    if (err instanceof UiaAttemptsExceededError) {
      return of(refused('attempts-exceeded'));
    }
    if (err instanceof UiaUnsupportedError) {
      return of(refused('no-usable-stage'));
    }
    const failure = describeMatrixRequestFailure(err);
    if (failure.kind === 'network' || failure.kind === 'timeout') {
      return this.resolveUnknown(accountId, hold, authenticated);
    }
    if (failure.kind === 'rate-limit') {
      const retryAfterMs = failure.diagnostic.retryAfterMs;
      return of({
        kind: 'kept',
        reason: 'rate-limited',
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      } as const);
    }
    return of(refused(refusalOf(err)));
  }

  /**
   * The request may have reached the server: a token that died while held, or a `whoami`
   * the server now refuses, means it was deleted.
   */
  private resolveUnknown(
    accountId: string,
    hold: ServerLogoutHold,
    authenticated: boolean,
  ): Observable<ServerAnswer> {
    if (hold.tokenDied()) return of({ kind: 'deleted' });
    return this.matrix.accountStatus(accountId).pipe(
      map((status): ServerAnswer => {
        if (status === 'gone' || hold.tokenDied()) return { kind: 'deleted' };
        if (status === 'active') {
          return refused(authenticated ? 'still-active' : 'unreachable');
        }
        return authenticated ? { kind: 'unconfirmed' } : refused('unreachable');
      }),
    );
  }

  private settle(
    accountId: string,
    hold: ServerLogoutHold,
    answer: ServerAnswer,
  ): Observable<AccountDeletionResult> {
    if (answer.kind !== 'deleted') {
      hold.release({ deleted: false });
      return of(
        answer.kind === 'unconfirmed'
          ? { kind: 'unconfirmed', accountId }
          : { ...answer, accountId },
      );
    }
    return this.removeDeleted(accountId).pipe(
      finalize(() => hold.release({ deleted: true })),
    );
  }
}

function kept(
  accountId: string,
  reason: AccountDeletionRefusal,
): AccountDeletionResult {
  return { kind: 'kept', accountId, reason };
}

function refused(reason: AccountDeletionRefusal): ServerAnswer {
  return { kind: 'kept', reason };
}

/**
 * `M_UNRECOGNIZED`, or a 404/405 that is not `M_NOT_FOUND`, means the endpoint is missing;
 * `M_FORBIDDEN` without UIA flows is the server's policy.
 */
function refusalOf(err: unknown): AccountDeletionRefusal {
  if (!(err instanceof MatrixError)) return 'failed';
  if (err.errcode === 'M_UNRECOGNIZED') return 'unsupported';
  if (
    (err.httpStatus === 404 || err.httpStatus === 405) &&
    err.errcode !== 'M_NOT_FOUND'
  ) {
    return 'unsupported';
  }
  if (err.errcode === 'M_FORBIDDEN') return 'forbidden';
  return 'failed';
}
