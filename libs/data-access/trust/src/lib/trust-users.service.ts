import {
  Injectable,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  type Observable,
  Subject,
  defer,
  from,
  map,
  merge,
  mergeMap,
  of,
  scan,
  startWith,
  switchMap,
  take,
  tap,
} from 'rxjs';
import {
  SessionStateService,
  projectActiveAccount,
} from '@trinity/data-access/matrix-client';
import { EngineRequestError, type EngineResult } from '@trinity/util/matrix';
import type { UserTrustFacts } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import {
  TrustOperationError,
  recoverTrustOperation,
  type TrustOperation,
} from './trust-operation-error';

/**
 * Another person's cross-signing identity as this Account sees it. A changed identity is
 * `verified-identity-changed` when this Account had verified the old one, else
 * `identity-changed` until acknowledged.
 */
export type UserTrust =
  'verified' | 'unverified' | 'identity-changed' | 'verified-identity-changed';

/** null while the account has no crypto. */
const toUserTrust = (result: EngineResult<UserTrustFacts>): UserTrust | null =>
  !result.ok
    ? null
    : result.value.verified
      ? 'verified'
      : result.value.wasVerified
        ? 'verified-identity-changed'
        : result.value.needsApproval
          ? 'identity-changed'
          : 'unverified';

/** Projects the active Account's verification view of other users; unknown while detached. */
@Injectable({ providedIn: 'root' })
export class TrustUsersService {
  private readonly engine = inject(TRUST_ENGINE);
  private readonly session = inject(SessionStateService);

  /** One writable signal per tracked user id, updated in place as trust changes. */
  private readonly states = new Map<string, WritableSignal<UserTrust | null>>();
  /** Users first asked about while the projection runs. */
  private readonly added = new Subject<string>();

  /**
   * One engine subscription per tracked user, all released when the projection resets, so
   * an Account switch or a released projection never exposes the previous Account's view.
   */
  private readonly projection = projectActiveAccount<
    ReadonlyMap<string, UserTrust | null>
  >({
    id: 'crypto.users',
    subscribe: (accountId) =>
      merge(
        defer(() => from([...this.states.keys()])),
        this.added,
      ).pipe(
        mergeMap((userId) =>
          this.engine
            .userTrust(accountId, userId)
            .pipe(map((result) => [userId, toUserTrust(result)] as const)),
        ),
        scan(
          (all, [userId, trust]) => new Map(all).set(userId, trust),
          new Map<string, UserTrust | null>(),
        ),
        startWith(new Map<string, UserTrust | null>()),
      ),
    rebuild: (all) => {
      for (const [userId, trust] of all) this.states.get(userId)?.set(trust);
    },
    reset: () => {
      for (const state of this.states.values()) state.set(null);
    },
  });

  /** Cold user-trust projection retained by the named session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /**
   * Reactive trust for a user; null while the projection or crypto is unavailable. The
   * returned signal is cached per user id and reused on later calls.
   */
  userTrust(userId: string): Signal<UserTrust | null> {
    let state = this.states.get(userId);
    if (!state) {
      state = signal<UserTrust | null>(null);
      this.states.set(userId, state);
      this.added.next(userId);
    }
    return state.asReadonly();
  }

  /** Accept a changed identity as this person's own (pin it). Cold; runs as the active Account. */
  acknowledgeIdentity(userId: string): Observable<void> {
    return this.identityAction('acknowledge-identity', userId, (accountId) =>
      this.engine.pinIdentity(accountId, userId),
    );
  }

  /**
   * Stop requiring a previously verified person to be verified, accepting their new identity as
   * unverified. Cold; runs as the active Account.
   */
  withdrawVerification(userId: string): Observable<void> {
    return this.identityAction('withdraw-verification', userId, (accountId) =>
      this.engine.withdrawVerification(accountId, userId),
    );
  }

  /** Run one identity change, then re-read the user so their state updates before completing. */
  private identityAction(
    operation: TrustOperation,
    userId: string,
    run: (accountId: string) => Observable<EngineResult<null>>,
  ): Observable<void> {
    const notReady = () =>
      new TrustOperationError(
        operation,
        'not-ready',
        'retry',
        'Encryption is still starting. Try again in a moment.',
      );
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) throw notReady();
      return run(accountId).pipe(
        switchMap((result) => {
          if (!result.ok && result.failure.code === 'crypto-not-ready') {
            throw notReady();
          }
          if (!result.ok) throw new EngineRequestError(result.failure);
          const state = this.states.get(userId);
          // Settle the re-read before completing, so the caller's busy state outlasts it.
          return state && this.projection.accountId() === accountId
            ? this.engine.userTrust(accountId, userId).pipe(
                take(1),
                tap((trust) => state.set(toUserTrust(trust))),
              )
            : of(null);
        }),
      );
    }).pipe(
      map(() => undefined),
      recoverTrustOperation(operation),
    );
  }
}
