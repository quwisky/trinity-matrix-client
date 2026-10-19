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
import type { Observable } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';

/** Another person's cross-signing identity as this Account sees it. */
export type UserTrust = 'verified' | 'unverified' | 'changed';

const toUserTrust = (
  status: Pick<
    UserVerificationStatus,
    'isCrossSigningVerified' | 'wasCrossSigningVerified'
  >,
): UserTrust =>
  status.isCrossSigningVerified()
    ? 'verified'
    : status.wasCrossSigningVerified()
      ? 'changed'
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
      for (const userId of this.states.keys()) this.read(userId, client);
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
      if (client) this.read(userId, client);
    }
    return state.asReadonly();
  }

  private read(userId: string, client: TrustMatrixClient): void {
    const generation = this.nextGeneration(userId);
    const state = this.states.get(userId);
    const crypto = client.getCrypto();
    if (!crypto) {
      state?.set(null);
      return;
    }
    void crypto.getUserVerificationStatus(userId).then(
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
