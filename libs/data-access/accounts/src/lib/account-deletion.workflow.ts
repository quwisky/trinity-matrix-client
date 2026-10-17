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
  Subject,
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
  /**
   * Holds kept after an unconfirmed deletion: the account was most likely deleted, so a
   * later dead token must run the deletion cleanup rather than the plain hard-logout wipe.
   */
  private readonly unconfirmed = new Map<string, ServerLogoutHold>();
  /** Deletions finished this session, so a later check answers without the gone client. */
  private readonly finished = new Map<string, AccountDeletionResult>();
  private readonly late = new Subject<AccountDeletionResult>();

  /** Deletions settled after their request reported them unconfirmed. Hot; never replays. */
  readonly lateDeletions: Observable<AccountDeletionResult> =
    this.late.asObservable();

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
      const hold = this.holdFor(accountId);
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
      const known = this.finished.get(accountId);
      if (known) return of(known);
      const hold = this.holdFor(accountId);
      return this.resolveUnknown(accountId, hold, true).pipe(
        switchMap((answer) => this.settle(accountId, hold, answer)),
      );
    });
  }

  /** Clean up an account whose deletion is already known, such as at its provider. */
  removeDeleted(accountId: string): Observable<AccountDeletionResult> {
    return this.accounts.removeDeletedAccount(accountId).pipe(
      map((cleanup): AccountDeletionResult => {
        const result = { kind: 'deleted', accountId, cleanup } as const;
        this.finished.set(accountId, result);
        return result;
      }),
    );
  }

  private holdFor(accountId: string): ServerLogoutHold {
    return this.matrix.holdServerLogout(accountId, {
      onTokenDied: () => this.finishUnconfirmed(accountId),
    });
  }

  /** The token of an account left unconfirmed died: it was deleted after all. */
  private finishUnconfirmed(accountId: string): void {
    const hold = this.unconfirmed.get(accountId);
    if (!hold) return;
    this.unconfirmed.delete(accountId);
    this.removeDeleted(accountId)
      .pipe(finalize(() => hold.release({ deleted: true })))
      .subscribe((result) => this.late.next(result));
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
    if (hold.tokenDied()) return of({ kind: 'deleted' });
    const failure = describeMatrixRequestFailure(err);
    if (failure.kind === 'rate-limit') {
      const retryAfterMs = failure.diagnostic.retryAfterMs;
      return of({
        kind: 'kept',
        reason: 'rate-limited',
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      } as const);
    }
    const refusal = refusalOf(err);
    // Only a definite refusal proves nothing was deleted; a 5xx, a proxy error or a lost
    // answer may follow a deactivation the server completed.
    if (
      failure.kind === 'network' ||
      failure.kind === 'timeout' ||
      (authenticated && refusal === 'failed')
    ) {
      return this.resolveUnknown(accountId, hold, authenticated);
    }
    return of(refused(refusal));
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
    const pending = this.unconfirmed.get(accountId);
    if (answer.kind === 'unconfirmed') {
      if (pending?.isHeld()) {
        hold.release({ deleted: false });
      } else {
        this.unconfirmed.set(accountId, hold);
      }
      return of({ kind: 'unconfirmed', accountId });
    }
    this.unconfirmed.delete(accountId);
    if (answer.kind === 'kept') {
      hold.release({ deleted: false });
      pending?.release({ deleted: false });
      return of({ ...answer, accountId });
    }
    return this.removeDeleted(accountId).pipe(
      finalize(() => {
        hold.release({ deleted: true });
        pending?.release({ deleted: true });
      }),
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
