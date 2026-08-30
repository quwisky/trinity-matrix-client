import { Injectable, inject, type Signal } from '@angular/core';
import type { EmittedEvents, MatrixClient } from 'matrix-js-sdk';
import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import { MatrixClientService } from './matrix-client.service';
import { projectFromClient } from './project-from-client';
import type { SecretStorageKeyHolder } from './secret-storage-key-holder';

/** Crypto protocol operations owned by Trust; SDK/runtime lifecycle is intentionally absent. */
export type TrustCryptoApi = Pick<
  CryptoApi,
  | 'bootstrapCrossSigning'
  | 'bootstrapSecretStorage'
  | 'checkKeyBackupAndEnable'
  | 'createRecoveryKeyFromPassphrase'
  | 'crossSignDevice'
  | 'exportRoomKeysAsJson'
  | 'exportSecretsBundle'
  | 'getActiveSessionBackupVersion'
  | 'getCrossSigningStatus'
  | 'getDeviceVerificationStatus'
  | 'getKeyBackupInfo'
  | 'getVerificationRequestsToDeviceInProgress'
  | 'importRoomKeysAsJson'
  | 'importSecretsBundle'
  | 'isCrossSigningReady'
  | 'isSecretStorageReady'
  | 'loadSessionBackupPrivateKeyFromSecretStorage'
  | 'requestOwnUserVerification'
  | 'requestVerificationDM'
  | 'userHasCrossSigningKeys'
>;

/** Matrix protocol surface needed by Trust; account and sync lifecycle methods are absent. */
export type TrustMatrixClient = Pick<
  MatrixClient,
  | 'deleteDevice'
  | 'deleteMultipleDevices'
  | 'getDeviceId'
  | 'getDevices'
  | 'getUserId'
  | 'off'
  | 'on'
  | 'setAccountDataRaw'
  | 'setDeviceDetails'
> & {
  readonly http: Pick<MatrixClient['http'], 'authedRequest'>;
  readonly secretStorage: MatrixClient['secretStorage'];
  getCrypto(): TrustCryptoApi | undefined;
};

/**
 * One synchronous view of the active Account's already-started crypto machine.
 *
 * Trust may use this view for protocol work, but it cannot start, stop, add, remove, or
 * switch Accounts. Matrix Runtime retains those lifecycle operations.
 */
export interface ActiveTrustCrypto {
  readonly client: TrustMatrixClient;
  readonly crypto: TrustCryptoApi | null;
}

/** A Trust projection with Matrix Runtime supplied and raw SDK clients kept behind the adapter. */
export interface TrustCryptoProjectionConfig {
  readonly id: string;
  readonly rebuild?: (client: TrustMatrixClient) => void;
  readonly events?: readonly EmittedEvents[];
  readonly bind?: (client: TrustMatrixClient) => void;
  readonly unbind?: (client: TrustMatrixClient) => void;
  readonly reset?: () => void;
  readonly reprojectOnSwitch?: boolean;
}

/** Lifecycle controls for a Trust projection without its raw-client escape hatch. */
export interface TrustCryptoProjection {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  client(): TrustMatrixClient | null;
  schedule(): void;
}

/**
 * The narrow Matrix adapter consumed by Trust.
 *
 * Its interface deliberately exposes only the active, already-started crypto context and
 * active-Account projection primitive. Account connection and crypto-machine startup stay
 * on {@link MatrixClientService} and are impossible through this port.
 */
@Injectable({ providedIn: 'root' })
export class TrustCryptoPort {
  private readonly matrix = inject(MatrixClientService);

  /** Account identity is observable without exposing Matrix Runtime's writable lifecycle. */
  readonly activeAccountId: Signal<string | null> = this.matrix.activeUserId;

  /** Whether an already-started active Account is available. */
  isAvailable(): boolean {
    return this.matrix.isInitialized;
  }

  /** Capture the active Account and its crypto objects once for one Trust operation. */
  active(): ActiveTrustCrypto {
    const client = this.matrix.instance;
    return {
      client: client as TrustMatrixClient,
      crypto: client.getCrypto() ?? null,
    };
  }

  /** Capture the active Account's ephemeral 4S key holder only when recovery needs it. */
  secretStorageKey(): SecretStorageKeyHolder | null {
    return this.matrix.activeHolder();
  }

  /** Create an active-Account projection without exposing Matrix Runtime lifecycle. */
  project(config: TrustCryptoProjectionConfig): TrustCryptoProjection {
    const projection = projectFromClient({
      id: config.id,
      matrix: this.matrix,
      ...(config.events ? { events: config.events } : {}),
      ...(config.rebuild
        ? {
            rebuild: (client: MatrixClient) =>
              config.rebuild?.(client as TrustMatrixClient),
          }
        : {}),
      ...(config.bind
        ? {
            bind: (client: MatrixClient) =>
              config.bind?.(client as TrustMatrixClient),
          }
        : {}),
      ...(config.unbind
        ? {
            unbind: (client: MatrixClient) =>
              config.unbind?.(client as TrustMatrixClient),
          }
        : {}),
      ...(config.reset ? { reset: config.reset } : {}),
      ...(config.reprojectOnSwitch === undefined
        ? {}
        : { reprojectOnSwitch: config.reprojectOnSwitch }),
    });
    return {
      connect: () => projection.connect(),
      disconnect: () => projection.disconnect(),
      isConnected: () => projection.isConnected(),
      client: () => projection.client() as TrustMatrixClient | null,
      schedule: () => projection.schedule(),
    };
  }
}
