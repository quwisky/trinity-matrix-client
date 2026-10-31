import { Injectable, inject } from '@angular/core';
import {
  MatrixClientService,
  type PersistedAccountStartOutcome,
} from '@trinity/data-access/matrix-client';
import {
  AccountAlreadyStoredError,
  AccountHomeserverMismatchError,
  NativeTokenBridge,
  SessionStorageService,
  sameHomeserver,
} from '@trinity/platform-native';
import {
  Observable,
  Subject,
  catchError,
  defer,
  map,
  of,
  switchMap,
  tap,
  throwError,
  timeout,
} from 'rxjs';
import type { MatrixSession } from '@trinity/util/matrix';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { AccountLifecycleAdapter } from './account-lifecycle.adapter';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import type {
  AccountRuntimeAdapter,
  AdapterAccountEstablishmentOutcome,
  AdapterAccountRestoreOutcome,
  AdapterAccountSwitchOutcome,
  SavedAccountsSnapshot,
} from './account-runtime.adapter';
import {
  authenticatedAccountGrantPayload,
  sameAuthenticatedAccountGrant,
  type AuthenticatedAccountGrant,
} from './authenticated-account-grant';
import type {
  AccountEstablishmentIntent,
  AccountCleanupIssue,
  AccountRestoreRole,
  AccountSignOutOutcome,
  InstallationResetOutcome,
  NewDeviceEstablishment,
} from './account-runtime.models';
import { UnprotectedStorageGate } from './unprotected-storage.gate';

/** What the saved record says about a sign-in's device; `unknown` is never reported as new. */
type DeviceNovelty = 'new' | 'existing' | 'unknown';

@Injectable({ providedIn: 'root' })
export class MatrixAccountRuntimeAdapter implements AccountRuntimeAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly nativeTokens = inject(NativeTokenBridge);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);
  private readonly lifecycleAdapter = inject(AccountLifecycleAdapter);
  private readonly unprotectedStorage = inject(UnprotectedStorageGate);
  private readonly pendingNewAccounts = new Map<
    string,
    {
      readonly grant: AuthenticatedAccountGrant;
      readonly stored: ReturnType<typeof authenticatedAccountGrantPayload>;
    }
  >();
  private readonly newDeviceFacts = new Subject<NewDeviceEstablishment>();

  readonly activeAccountId = this.matrix.activeUserId;
  readonly newDevices: Observable<NewDeviceEstablishment> =
    this.newDeviceFacts.asObservable();

  sweepOrphanedStores(): Observable<void> {
    return this.storage.sweepOrphanedCryptoStores();
  }

  sweepNativeTokens(): Observable<void> {
    return this.storage.sweepNativeTokens();
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

  /**
   * Before anything is stored or any live Account is touched, a host without a usable
   * keychain asks whether this account's secrets may be stored unprotected on disk.
   * Declining leaves everything as it was.
   */
  establishAccount(
    grant: AuthenticatedAccountGrant,
    intent: AccountEstablishmentIntent,
  ): Observable<AdapterAccountEstablishmentOutcome> {
    return this.unprotectedStorage.allowed().pipe(
      switchMap((allowed) =>
        allowed
          ? this.establishConsented(grant, intent)
          : of({
              kind: 'failed' as const,
              failure: 'unprotected-storage-declined' as const,
            }),
      ),
    );
  }

  private establishConsented(
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
      let replaced: MatrixSession | null = null;
      let novelty: DeviceNovelty = 'unknown';
      const persisted$ =
        intent.accountRecord === 'new' &&
        pending &&
        sameAuthenticatedAccountGrant(pending.grant, grant)
          ? // A retried first establishment: the attempt that saved the record published
            // its device already.
            of(pending.stored)
          : this.priorDevice(session).pipe(
              tap((prior) => {
                replaced = prior.replaced;
                novelty = prior.novelty;
              }),
              switchMap(() =>
                this.storage.persistForEstablishment(
                  session,
                  intent.accountRecord,
                ),
              ),
              tap((stored) => {
                if (intent.accountRecord === 'new') {
                  this.pendingNewAccounts.set(session.userId, {
                    grant,
                    stored,
                  });
                }
                // Published at once, whatever the later outcome: the next launch restores
                // a saved record without asking whether it was new. Saving a new record
                // refuses an Account that already has one.
                if (intent.accountRecord === 'new' || novelty === 'new') {
                  this.newDeviceFacts.next({
                    accountId: session.userId,
                    deviceId: session.deviceId,
                  });
                }
              }),
              switchMap((stored) =>
                this.nativeTokens
                  .removeUnreadableRecord(stored)
                  .pipe(map(() => stored)),
              ),
            );
      const prepare$ =
        intent.liveAccounts === 'replace'
          ? defer(() => {
              this.lifecycle.releaseSharedCaches();
              // Best effort: a refused or stalled handoff write must neither fail nor block
              // the sign-in, nor skip the pusher teardown.
              return this.lifecycle.forgetPushHandoff().pipe(
                timeout(ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister),
                catchError(() => of(void 0)),
                switchMap(() => this.lifecycle.unregisterNotifications()),
              );
            })
          : of(void 0);

      return prepare$.pipe(
        switchMap(() => persisted$),
        map((stored) => ({ kind: 'persisted' as const, stored })),
        catchError((error: unknown) => this.storageFailure(error)),
        switchMap((persisted) =>
          persisted.kind === 'failed'
            ? of(persisted)
            : this.matrix.restorePersisted(persisted.stored, 'background').pipe(
                tap((started) => {
                  if (started.kind === 'ready' && replaced) {
                    this.signOutReplacedDevice(replaced);
                  }
                }),
              ),
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
        switchMap((outcome) =>
          outcome.kind === 'ready' &&
          intent.placement === 'active' &&
          intent.liveAccounts === 'keep'
            ? this.lifecycle.registerNotifications().pipe(map(() => outcome))
            : of(outcome),
        ),
      );
    });
  }

  prepareActiveAccount(
    accountId: string,
  ): Observable<AdapterAccountSwitchOutcome> {
    return defer(() =>
      of(
        this.matrix.clientFor(accountId)
          ? ({ kind: 'ready' } as const)
          : ({ kind: 'failed', failure: 'account-unavailable' } as const),
      ),
    );
  }

  commitActiveAccount(
    accountId: string,
  ): Observable<AdapterAccountSwitchOutcome> {
    return defer(() => {
      if (!this.matrix.clientFor(accountId)) {
        return of({
          kind: 'failed',
          failure: 'account-unavailable',
        } as const);
      }
      return this.storage.setActiveForEstablishment(accountId).pipe(
        tap(() => this.matrix.setActive(accountId)),
        map(() => ({ kind: 'ready' as const })),
        catchError((error: unknown) =>
          this.isExpectedStorageFailure(error)
            ? of({
                kind: 'failed' as const,
                failure: 'local-state-unavailable' as const,
              })
            : throwError(() => error),
        ),
      );
    });
  }

  signOutAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return this.lifecycleAdapter.signOutAccount(accountId);
  }

  removeDeletedAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return this.lifecycleAdapter.removeDeletedAccount(accountId);
  }

  retrySignOutCleanup(
    accountId: string,
    issues: readonly AccountCleanupIssue[],
  ): Observable<AccountSignOutOutcome> {
    return this.lifecycleAdapter.retrySignOutCleanup(accountId, issues);
  }

  resetInstallation(): Observable<InstallationResetOutcome> {
    return this.lifecycleAdapter.resetInstallation();
  }

  retryInstallationCleanup(
    issues: readonly AccountCleanupIssue[],
  ): Observable<InstallationResetOutcome> {
    return this.lifecycleAdapter.retryInstallationCleanup(issues);
  }

  private storageFailure(
    error: unknown,
  ): Observable<
    Extract<AdapterAccountEstablishmentOutcome, { readonly kind: 'failed' }>
  > {
    if (error instanceof AccountHomeserverMismatchError) {
      return of({
        kind: 'failed',
        failure: 'homeserver-mismatch',
        storedBaseUrl: error.storedBaseUrl,
      });
    }
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

  /**
   * What the saved record says about this sign-in's device, read before saving the new
   * session overwrites it. Novelty comes from the token-free record, so re-authenticating
   * a signed-out Account (whose record keeps its device id but no token) on that device is
   * not new. The same device id is a re-authentication; no record is a first sign-in
   * here; a failed read is `unknown`: it proves nothing, so it is never reported as new.
   * A different device on the same homeserver is replaced: its session is loaded so it
   * can be signed out once the new session starts (saving reclaims its local store, so
   * nothing could reach it afterwards). A device saved through another server is not
   * replaced, because saving refuses that sign-in (`AccountHomeserverMismatchError`).
   */
  private priorDevice(session: MatrixSession): Observable<{
    readonly replaced: MatrixSession | null;
    readonly novelty: DeviceNovelty;
  }> {
    return defer(() => this.storage.record(session.userId)).pipe(
      switchMap((record) => {
        if (!record) return of({ replaced: null, novelty: 'new' as const });
        if (record.deviceId === session.deviceId) {
          return of({ replaced: null, novelty: 'existing' as const });
        }
        return this.replacedSession(session).pipe(
          map((replaced) => ({ replaced, novelty: 'new' as const })),
        );
      }),
      catchError(() => of({ replaced: null, novelty: 'unknown' as const })),
    );
  }

  /** The saved session of a different device on the same homeserver, when it has a token. */
  private replacedSession(
    session: MatrixSession,
  ): Observable<MatrixSession | null> {
    return defer(() => this.storage.load(session.userId)).pipe(
      map((stored) =>
        stored &&
        stored.deviceId !== session.deviceId &&
        sameHomeserver(stored.baseUrl, session.baseUrl)
          ? stored
          : null,
      ),
      catchError(() => of(null)),
    );
  }

  /**
   * Sign the replaced device out on the server, once the new session is saved and started:
   * starting it detached any old live client for this account, so that client's logout
   * handling never sees this sign-out, and a failed save never leaves the account without
   * any session. Best-effort with the old token on a detached client (for OAuth,
   * `logout(true)` revokes at the provider), then drops its native tokens; it never delays
   * or fails the sign-in.
   */
  private signOutReplacedDevice(stored: MatrixSession): void {
    defer(() =>
      this.matrix
        .detachedClient(stored, { persistRefreshedTokens: false })
        .logout(true),
    )
      .pipe(
        catchError(() => of(void 0)),
        // The sign-in left the old device's native tokens for this logout to revoke.
        switchMap(() => this.storage.removeNativeTokens(stored.userId)),
      )
      .subscribe({ error: () => undefined });
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
