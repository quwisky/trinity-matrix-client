import { InjectionToken } from '@angular/core';
import type {
  DeviceAccessTokenResponse,
  MatrixClient,
  ValidatedAuthMetadata,
} from 'matrix-js-sdk';
import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import type { Observable } from 'rxjs';

/** The secrets bundle an existing device shares, in the shape `importSecretsBundle` takes. */
export type LinkedSecrets = Parameters<
  NonNullable<CryptoApi['importSecretsBundle']>
>[0];

/** The new device's sign-in steps that the QR flow hands to the auth workflow. */
export interface QrSignInCompletion {
  /** The OAuth client ID registered with the device-code grant for this homeserver and issuer. */
  deviceGrantClientId(
    metadata: ValidatedAuthMetadata,
    homeserverUrl: string,
  ): Observable<string>;
  /** Forgets that client ID, so the next {@link deviceGrantClientId} registers again. */
  forgetDeviceGrantClientId(
    metadata: ValidatedAuthMetadata,
    homeserverUrl: string,
  ): Observable<void>;
  /**
   * Signs in with the device-grant tokens and emits the signed-in client. The device must
   * exist on the server when this emits: the existing device shares secrets only then.
   */
  completeDeviceGrant(
    tokens: DeviceAccessTokenResponse,
    clientId: string,
    metadata: ValidatedAuthMetadata,
    homeserverUrl: string,
  ): Observable<MatrixClient>;
  /** Imports the shared secrets and emits whether this device ended verified. */
  importLinkedSecrets(
    client: MatrixClient,
    secrets: LinkedSecrets,
  ): Observable<boolean>;
}

export const QR_SIGN_IN_COMPLETION = new InjectionToken<QrSignInCompletion>(
  'auth.qr-sign-in-completion',
);
