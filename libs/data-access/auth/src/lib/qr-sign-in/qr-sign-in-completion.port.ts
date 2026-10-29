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
  /**
   * The metadata to run the device grant on, with token and device endpoints the issuer
   * confirms. Errors when they are not confirmed, before anything is sent to them.
   */
  deviceGrantMetadata(
    metadata: ValidatedAuthMetadata,
  ): Observable<ValidatedAuthMetadata>;
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

/** The existing device's check, before it links another device, that it holds the published identity. */
export interface QrLinkIdentityCheck {
  /**
   * Emits whether this device caches the private keys of the cross-signing identity the
   * homeserver publishes. Keys a cancelled reset left behind were never published, and the
   * new device would trust them without asking the server.
   */
  holdsPublishedIdentity(accountId: string): Observable<boolean>;
}

export const QR_LINK_IDENTITY_CHECK = new InjectionToken<QrLinkIdentityCheck>(
  'auth.qr-link-identity-check',
);
