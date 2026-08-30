import { Injectable, computed, inject, signal } from '@angular/core';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { Observable, defer, from } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustCryptoApi,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import { recoverTrustOperation } from './trust-operation-error';

/** Where this device stands relative to the Account's encryption setup. */
export type TrustStatus =
  'unknown' | 'ready' | 'needs-setup' | 'needs-recovery';

/** Atomic, immutable encryption-health view projected from authoritative SDK state. */
export interface TrustHealth {
  readonly status: TrustStatus;
  readonly keyBackupActive: boolean;
  readonly thisDeviceVerified: boolean;
}

const UNKNOWN_TRUST_HEALTH: TrustHealth = Object.freeze({
  status: 'unknown',
  keyBackupActive: false,
  thisDeviceVerified: false,
});

/** Internal active-Account projection behind {@link TrustService}'s health facade. */
@Injectable({ providedIn: 'root' })
export class TrustHealthService {
  private readonly cryptoPort = inject(TrustCryptoPort);

  private readonly _health = signal<TrustHealth>(UNKNOWN_TRUST_HEALTH);
  readonly health = this._health.asReadonly();
  readonly status = computed(() => this.health().status);
  readonly keyBackupActive = computed(() => this.health().keyBackupActive);
  readonly thisDeviceVerified = computed(
    () => this.health().thisDeviceVerified,
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
    ],
    // Event-driven reads are deliberately best effort. A sync burst must not create an
    // unhandled rejection, and a transient SDK failure leaves the last coherent view.
    rebuild: (client) => void this.reconcile(client),
    reset: () => {
      this.statusGeneration++;
      this._health.set(UNKNOWN_TRUST_HEALTH);
    },
  });

  connect(): void {
    this.projection.connect();
  }

  disconnect(): void {
    this.projection.disconnect();
  }

  /** Explicit command: unlike event reconciliation, a failed read is visible to callers. */
  refresh(): Observable<void> {
    return defer(() => {
      const context = this.cryptoPort.isAvailable()
        ? this.cryptoPort.active()
        : null;
      return from(
        this.computeStatus(
          true,
          context?.client ?? null,
          context?.crypto ?? null,
        ),
      );
    }).pipe(recoverTrustOperation('refresh-health'));
  }

  /** Best-effort internal reconciliation after a Trust mutation or protocol event. */
  async reconcile(projectedClient?: TrustMatrixClient): Promise<void> {
    const context = projectedClient
      ? {
          client: projectedClient,
          crypto: projectedClient.getCrypto() ?? null,
        }
      : this.cryptoPort.isAvailable()
        ? this.cryptoPort.active()
        : null;
    await this.computeStatus(
      false,
      context?.client ?? null,
      context?.crypto ?? null,
    );
  }

  private async computeStatus(
    reportFailure: boolean,
    client: TrustMatrixClient | null,
    crypto: TrustCryptoApi | null,
  ): Promise<void> {
    const generation = ++this.statusGeneration;
    const isCurrent = (): boolean => generation === this.statusGeneration;
    try {
      if (!client || !crypto) {
        if (isCurrent()) {
          this._health.set(UNKNOWN_TRUST_HEALTH);
        }
        return;
      }

      const [
        crossSigningReady,
        secretStorageReady,
        backupVersion,
        defaultKeyId,
      ] = await Promise.all([
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

      if (!isCurrent()) {
        return;
      }
      this._health.set({
        keyBackupActive: backupVersion !== null,
        thisDeviceVerified: deviceStatus?.crossSigningVerified ?? false,
        status:
          crossSigningReady && secretStorageReady
            ? 'ready'
            : defaultKeyId
              ? 'needs-recovery'
              : 'needs-setup',
      });
    } catch (cause) {
      if (reportFailure) {
        throw cause;
      }
      // Keep the last atomic view on a transient event-driven SDK failure.
    }
  }
}
