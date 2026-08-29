import { Injectable, inject } from '@angular/core';
import {
  MatrixClientService,
  type PersistedAccountStartOutcome,
} from '@trinity/data-access/matrix-client';
import {
  AccountAlreadyStoredError,
  SessionStorageService,
} from '@trinity/platform-native';
import {
  Observable,
  catchError,
  defer,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import type {
  AccountRuntimeAdapter,
  AdapterAccountEstablishmentOutcome,
  AdapterAccountRestoreOutcome,
  SavedAccountsSnapshot,
} from './account-runtime.adapter';
import {
  authenticatedAccountGrantPayload,
  sameAuthenticatedAccountGrant,
  type AuthenticatedAccountGrant,
} from './authenticated-account-grant';
import type {
  AccountEstablishmentIntent,
  AccountRestoreRole,
} from './account-runtime.models';

@Injectable({ providedIn: 'root' })
export class MatrixAccountRuntimeAdapter implements AccountRuntimeAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly pendingNewAccounts = new Map<
    string,
    {
      readonly grant: AuthenticatedAccountGrant;
      readonly stored: ReturnType<typeof authenticatedAccountGrantPayload>;
    }
  >();

  readonly activeAccountId = this.matrix.activeUserId;

  sweepOrphanedStores(): Observable<void> {
    return this.storage.sweepOrphanedCryptoStores();
  }

  readSavedAccounts(): Observable<SavedAccountsSnapshot> {
    return this.storage.snapshot().pipe(
      map((snapshot) => ({
        kind: 'available' as const,
        activeAccountId: snapshot.activeAccountId,
        accountIds: snapshot.accounts.map((account) => account.userId),
      })),
      catchError(() => of({ kind: 'corrupt-local-state' as const })),
    );
  }

  restoreAccount(
    accountId: string,
    role: AccountRestoreRole,
  ): Observable<AdapterAccountRestoreOutcome> {
    return this.storage.load(accountId).pipe(
      map((session) => ({ kind: 'loaded' as const, session })),
      catchError(() =>
        of({
          kind: 'failed' as const,
          failure: 'corrupt-local-state' as const,
        }),
      ),
      switchMap((loaded) => {
        if (loaded.kind === 'failed') {
          return of(loaded);
        }
        const { session } = loaded;
        if (!session) {
          this.matrix.requireReauthentication(accountId);
          return of({ kind: 'reauthentication-required' as const });
        }
        return this.matrix
          .restorePersisted(
            session,
            role === 'active' ? 'activate' : 'background',
          )
          .pipe(map((outcome) => this.toAdapterOutcome(outcome)));
      }),
    );
  }

  establishAccount(
    grant: AuthenticatedAccountGrant,
    intent: AccountEstablishmentIntent,
  ): Observable<AdapterAccountEstablishmentOutcome> {
    return defer(() => {
      const session = authenticatedAccountGrantPayload(grant);
      const previousActiveAccountId = this.activeAccountId();
      if (intent.placement === 'inactive' && !this.activeAccountId()) {
        return of({
          kind: 'failed',
          failure: 'active-account-required',
        } as const);
      }
      const pending = this.pendingNewAccounts.get(session.userId);
      const persisted$ =
        intent.accountRecord === 'new' &&
        pending &&
        sameAuthenticatedAccountGrant(pending.grant, grant)
          ? of(pending.stored)
          : this.storage
              .persistForEstablishment(session, intent.accountRecord)
              .pipe(
                tap((stored) => {
                  if (intent.accountRecord === 'new') {
                    this.pendingNewAccounts.set(session.userId, {
                      grant,
                      stored,
                    });
                  }
                }),
              );

      return persisted$.pipe(
        map((stored) => ({ kind: 'persisted' as const, stored })),
        catchError((error: unknown) => this.storageFailure(error)),
        switchMap((persisted) =>
          persisted.kind === 'failed'
            ? of(persisted)
            : this.matrix.restorePersisted(persisted.stored, 'background'),
        ),
        switchMap((started) => {
          if (started.kind === 'failed') {
            return of(started);
          }
          if (intent.placement === 'inactive') {
            this.pendingNewAccounts.delete(session.userId);
            return of({ kind: 'ready' as const });
          }
          let activePointerCommitted = false;
          return defer(() => {
            if (!this.matrix.clientFor(session.userId)) {
              throw new Error(
                `Account Runtime cannot commit placement for a non-live Account: ${session.userId}`,
              );
            }
            return this.storage.setActiveForEstablishment(session.userId).pipe(
              tap(() => {
                activePointerCommitted = true;
                this.matrix.activateAccount(
                  session.userId,
                  intent.liveAccounts,
                );
              }),
              map(() => ({ kind: 'ready' as const })),
              catchError((error: unknown) =>
                this.rollbackPlacement(
                  session.userId,
                  previousActiveAccountId,
                  activePointerCommitted,
                  error,
                ),
              ),
            );
          });
        }),
        tap((outcome) => {
          if (outcome.kind === 'ready') {
            this.pendingNewAccounts.delete(session.userId);
          }
        }),
      );
    });
  }

  private storageFailure(
    error: unknown,
  ): Observable<
    Extract<AdapterAccountEstablishmentOutcome, { readonly kind: 'failed' }>
  > {
    if (error instanceof AccountAlreadyStoredError) {
      return of({ kind: 'failed', failure: 'account-already-stored' });
    }
    if (this.isExpectedStorageFailure(error)) {
      return of({ kind: 'failed', failure: 'local-state-unavailable' });
    }
    return throwError(() => error);
  }

  private isExpectedStorageFailure(error: unknown): boolean {
    if (error instanceof TypeError) return false;
    if (error instanceof DOMException) {
      return [
        'AbortError',
        'InvalidStateError',
        'NotAllowedError',
        'QuotaExceededError',
        'UnknownError',
      ].includes(error.name);
    }
    if (!(error instanceof Error)) return false;
    return error.message === 'secure-store: the OS keychain is unavailable';
  }

  private rollbackPlacement(
    accountId: string,
    previousActiveAccountId: string | null,
    restoreActivePointer: boolean,
    originalError: unknown,
  ): Observable<
    Extract<AdapterAccountEstablishmentOutcome, { readonly kind: 'failed' }>
  > {
    return this.matrix.rollbackAccountStart(accountId).pipe(
      switchMap(() =>
        restoreActivePointer
          ? this.storage.restoreActiveAfterFailedEstablishment(
              previousActiveAccountId,
            )
          : of(void 0),
      ),
      catchError((rollbackError: unknown) =>
        throwError(
          () =>
            new AggregateError(
              [originalError, rollbackError],
              'Account placement rollback failed.',
            ),
        ),
      ),
      switchMap(() => this.storageFailure(originalError)),
    );
  }

  private toAdapterOutcome(
    outcome: PersistedAccountStartOutcome,
  ): AdapterAccountRestoreOutcome {
    if (outcome.kind === 'ready') {
      return outcome;
    }
    return outcome.failure === 'reauthentication-required'
      ? { kind: 'reauthentication-required' }
      : { kind: 'failed', failure: outcome.failure };
  }
}
