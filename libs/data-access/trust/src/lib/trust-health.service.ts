import { Injectable, computed, inject, signal } from '@angular/core';
import { ClientEvent } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { Observable, defer, from } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustCryptoApi,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import type { ProjectionReconcileContext } from '@trinity/runtime/projection';
import { recoverTrustOperation } from './trust-operation-error';
import { readTrustSnapshot } from './trust-snapshot';

/**
 * Where this device stands relative to the Account's encryption setup.
 * `needs-verification`: the Account has an identity published elsewhere and no recovery;
 * only verifying with a device that holds it (or an explicit reset) helps.
 */
export type TrustStatus =
  'unknown' | 'ready' | 'needs-setup' | 'needs-recovery' | 'needs-verification';

/** One coherent read of the active Account's authoritative crypto state. */
export interface TrustHealthSnapshot {
  readonly status: Exclude<TrustStatus, 'unknown'>;
  readonly keyBackupActive: boolean;
  readonly thisDeviceVerified: boolean;
  /**
   * The Account has no recovery and its published identity's private keys are on
   * another device, not this one. Local-only, like the `needs-verification` decision;
   * false whenever recovery exists or the device is ready.
   */
  readonly identityElsewhere: boolean;
}

/**
 * Current Trust availability. Stale values are separated from `current`, so consumers
 * cannot accidentally treat a retained last-known view as an authoritative decision.
 */
export type TrustHealth =
  | {
      readonly availability: 'coherent';
      readonly current: TrustHealthSnapshot;
      readonly stale: null;
    }
  | {
      readonly availability: 'stale';
      readonly current: null;
      readonly stale: TrustHealthSnapshot;
    }
  | {
      readonly availability: 'unavailable';
      readonly current: null;
      readonly stale: null;
    };

const UNAVAILABLE_TRUST_HEALTH: TrustHealth = Object.freeze({
  availability: 'unavailable',
  current: null,
  stale: null,
});

/**
 * The crypto and account-data events that can move an Account's trust status. The
 * active-Account projection and the per-Account summaries react to the same list.
 */
export const TRUST_HEALTH_EVENTS = [
  CryptoEvent.KeysChanged,
  CryptoEvent.UserTrustStatusChanged,
  CryptoEvent.KeyBackupStatus,
  CryptoEvent.DevicesUpdated,
  // Restored /sync may contain old secrets until fresh account data arrives.
  ClientEvent.AccountData,
] as const;

/** Internal active-Account projection behind {@link TrustService}'s health facade. */
@Injectable({ providedIn: 'root' })
export class TrustHealthService {
  private readonly cryptoPort = inject(TrustCryptoPort);

  private readonly _health = signal<TrustHealth>(UNAVAILABLE_TRUST_HEALTH);
  readonly health = this._health.asReadonly();
  readonly status = computed(() => this.health().current?.status ?? 'unknown');
  readonly keyBackupActive = computed(
    () => this.health().current?.keyBackupActive ?? null,
  );
  readonly thisDeviceVerified = computed(
    () => this.health().current?.thisDeviceVerified ?? null,
  );
  /**
   * This device is verified but setup would replace the identity another device holds,
   * so recovery can only be set up there (or the identity explicitly reset).
   */
  readonly recoverySetupElsewhere = computed(() => {
    const current = this.health().current;
    return (
      current?.status === 'needs-setup' &&
      current.thisDeviceVerified &&
      current.identityElsewhere
    );
  });

  /**
   * Monotonic token so a slow status run cannot overwrite a newer one, even within one
   * projection generation.
   */
  private statusGeneration = 0;

  private readonly projection = this.cryptoPort.project({
    id: 'trust.health',
    events: TRUST_HEALTH_EVENTS,
    rebuild: (client, context) =>
      defer(() => from(this.reconcileProjection(client, context))),
    reset: () => {
      this.statusGeneration++;
      this._health.set(UNAVAILABLE_TRUST_HEALTH);
    },
  });

  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Explicit command: unlike event reconciliation, a failed read is visible to callers. */
  refresh(): Observable<void> {
    return defer(() => {
      const context = this.cryptoPort.isAvailable()
        ? this.cryptoPort.active()
        : null;
      return from(
        this.refreshCurrent(context?.client ?? null, context?.crypto ?? null),
      );
    }).pipe(recoverTrustOperation('refresh-health'));
  }

  /** Best-effort internal reconciliation after a completed Trust mutation. */
  async reconcile(projectedClient?: TrustMatrixClient): Promise<void> {
    const context = projectedClient
      ? {
          client: projectedClient,
          crypto: projectedClient.getCrypto() ?? null,
        }
      : this.cryptoPort.isAvailable()
        ? this.cryptoPort.active()
        : null;
    try {
      await this.refreshCurrent(
        context?.client ?? null,
        context?.crypto ?? null,
      );
    } catch {
      // The mutation remains authoritative. Its follow-up view is explicitly stale or
      // unavailable, while the session projection owns visible recovery.
    }
  }

  /** Retry the retained projection rather than pretending a standalone refresh reattached it. */
  retryProjection(): void {
    this.projection.schedule();
  }

  private async reconcileProjection(
    client: TrustMatrixClient,
    context: ProjectionReconcileContext,
  ): Promise<void> {
    const generation = ++this.statusGeneration;
    try {
      const crypto = client.getCrypto() ?? null;
      if (!crypto)
        throw new Error('Trust crypto is unavailable for the active Account.');
      const snapshot = await this.readSnapshot(client, crypto);
      if (generation !== this.statusGeneration) return;
      context.publish(() => this.publishSnapshot(snapshot));
    } catch (cause) {
      if (generation === this.statusGeneration) {
        context.publish(() => this.publishFailure());
      }
      throw cause;
    }
  }

  private async refreshCurrent(
    client: TrustMatrixClient | null,
    crypto: TrustCryptoApi | null,
  ): Promise<void> {
    const generation = ++this.statusGeneration;
    try {
      const snapshot = await this.readSnapshot(client, crypto);
      if (generation === this.statusGeneration) this.publishSnapshot(snapshot);
    } catch (cause) {
      if (generation === this.statusGeneration) this.publishFailure();
      throw cause;
    }
  }

  private async readSnapshot(
    client: TrustMatrixClient | null,
    crypto: TrustCryptoApi | null,
  ): Promise<TrustHealthSnapshot | null> {
    return client && crypto ? readTrustSnapshot(client, crypto) : null;
  }

  private publishSnapshot(snapshot: TrustHealthSnapshot | null): void {
    this._health.set(
      snapshot
        ? { availability: 'coherent', current: snapshot, stale: null }
        : UNAVAILABLE_TRUST_HEALTH,
    );
  }

  private publishFailure(): void {
    const previous = this._health();
    const stale = previous.current ?? previous.stale;
    this._health.set(
      stale
        ? { availability: 'stale', current: null, stale }
        : UNAVAILABLE_TRUST_HEALTH,
    );
  }
}
