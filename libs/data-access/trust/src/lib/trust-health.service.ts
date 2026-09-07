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

/** Where this device stands relative to the Account's encryption setup. */
export type TrustStatus =
  'unknown' | 'ready' | 'needs-setup' | 'needs-recovery';

/** One coherent read of the active Account's authoritative crypto state. */
export interface TrustHealthSnapshot {
  readonly status: Exclude<TrustStatus, 'unknown'>;
  readonly keyBackupActive: boolean;
  readonly thisDeviceVerified: boolean;
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

  /** Monotonic token so a slow status run cannot overwrite a newer one. */
  private statusGeneration = 0;

  private readonly projection = this.cryptoPort.project({
    id: 'trust.health',
    events: [
      CryptoEvent.KeysChanged,
      CryptoEvent.UserTrustStatusChanged,
      CryptoEvent.KeyBackupStatus,
      CryptoEvent.DevicesUpdated,
      // Restored /sync may contain old secrets until fresh account data arrives.
      ClientEvent.AccountData,
    ],
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
    if (!client || !crypto) return null;
    const [crossSigningReady, secretStorageReady, backupVersion, defaultKeyId] =
      await Promise.all([
        crypto.isCrossSigningReady(),
        crypto.isSecretStorageReady(),
        crypto.getActiveSessionBackupVersion(),
        client.secretStorage.getDefaultKeyId(),
      ]);
    const deviceId = client.getDeviceId();
    const userId = client.getUserId();
    const deviceStatus =
      userId && deviceId
        ? await crypto.getDeviceVerificationStatus(userId, deviceId)
        : null;
    return {
      keyBackupActive: backupVersion !== null,
      thisDeviceVerified: deviceStatus?.crossSigningVerified ?? false,
      status:
        crossSigningReady && secretStorageReady
          ? 'ready'
          : defaultKeyId
            ? 'needs-recovery'
            : 'needs-setup',
    };
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
