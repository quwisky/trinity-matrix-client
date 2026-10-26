import {
  Injectable,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  CryptoEvent,
  type UserVerificationStatus,
} from 'matrix-js-sdk/lib/crypto-api';
import { defer, from, type Observable } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
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

const toUserTrust = (
  status: Pick<
    UserVerificationStatus,
    'isCrossSigningVerified' | 'wasCrossSigningVerified' | 'needsUserApproval'
  >,
): UserTrust =>
  status.isCrossSigningVerified()
    ? 'verified'
    : status.wasCrossSigningVerified()
      ? 'verified-identity-changed'
      : status.needsUserApproval
        ? 'identity-changed'
        : 'unverified';

/** Projects the active Account's verification view of other users; unknown while detached. */
@Injectable({ providedIn: 'root' })
export class TrustUsersService {
  private readonly cryptoPort = inject(TrustCryptoPort);

  /** One writable signal per tracked user id, updated in place as trust changes. */
  private readonly states = new Map<string, WritableSignal<UserTrust | null>>();
  /** Per-user read generation, so an older read cannot overwrite a newer status. */
  private readonly generations = new Map<string, number>();

  private readonly onTrustChanged = (
    userId: string,
    status: UserVerificationStatus,
  ): void => {
    const state = this.states.get(userId);
    if (!state) return;
    this.nextGeneration(userId);
    state.set(toUserTrust(status));
  };

  /**
   * The event is bound by hand because it carries the user and the new status. Reset keeps
   * an Account switch or a released projection from exposing the previous Account's view.
   */
  private readonly projection = this.cryptoPort.project({
    id: 'crypto.users',
    bind: (client) =>
      client.on(CryptoEvent.UserTrustStatusChanged, this.onTrustChanged),
    unbind: (client) =>
      client.off(CryptoEvent.UserTrustStatusChanged, this.onTrustChanged),
    rebuild: (client) => {
      for (const userId of this.states.keys()) void this.read(userId, client);
    },
    reset: () => {
      for (const [userId, state] of this.states) {
        this.nextGeneration(userId);
        state.set(null);
      }
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
      const client = this.projection.client();
      if (client) void this.read(userId, client);
    }
    return state.asReadonly();
  }

  /** Accept a changed identity as this person's own (pin it). Cold; runs as the active Account. */
  acknowledgeIdentity(userId: string): Observable<void> {
    return this.identityAction('acknowledge-identity', userId, (crypto) =>
      crypto.pinCurrentUserIdentity(userId),
    );
  }

  /**
   * Stop requiring a previously verified person to be verified, accepting their new identity as
   * unverified. Cold; runs as the active Account.
   */
  withdrawVerification(userId: string): Observable<void> {
    return this.identityAction('withdraw-verification', userId, (crypto) =>
      crypto.withdrawVerificationRequirement(userId),
    );
  }

  /** Run one identity change, then re-read the user so their state updates without the event. */
  private identityAction(
    operation: TrustOperation,
    userId: string,
    run: (
      crypto: NonNullable<ReturnType<TrustMatrixClient['getCrypto']>>,
    ) => Promise<void>,
  ): Observable<void> {
    return defer(() => {
      const { client, crypto } = this.cryptoPort.active();
      if (!crypto) {
        throw new TrustOperationError(
          operation,
          'not-ready',
          'retry',
          'Encryption is still starting. Try again in a moment.',
        );
      }
      // Settle the re-read before completing, so the caller's busy state outlasts it.
      return from(
        run(crypto).then(() =>
          this.states.has(userId) ? this.read(userId, client) : undefined,
        ),
      );
    }).pipe(recoverTrustOperation(operation));
  }

  private read(userId: string, client: TrustMatrixClient): Promise<void> {
    const generation = this.nextGeneration(userId);
    const state = this.states.get(userId);
    const crypto = client.getCrypto();
    if (!crypto) {
      state?.set(null);
      return Promise.resolve();
    }
    return crypto.getUserVerificationStatus(userId).then(
      (status) => this.settle(userId, generation, toUserTrust(status)),
      // The card reads trust decoratively; a failed read degrades to unverified.
      () => this.settle(userId, generation, 'unverified'),
    );
  }

  private settle(userId: string, generation: number, trust: UserTrust): void {
    if (this.generations.get(userId) === generation) {
      this.states.get(userId)?.set(trust);
    }
  }

  private nextGeneration(userId: string): number {
    const next = (this.generations.get(userId) ?? 0) + 1;
    this.generations.set(userId, next);
    return next;
  }
}
