import { InjectionToken, inject } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import { MatrixClientService } from './matrix-client.service';
import type { SecretStorageKeyHolder } from './secret-storage-key-holder';

export interface JsSdkClients {
  clientFor(accountId: string): MatrixClient | null;
  /** The secret-storage key holder of the account's live client. */
  holderFor(accountId: string): SecretStorageKeyHolder | null;
  /**
   * Keep the secrets a QR sign-in received for the session this user and device will start;
   * that start imports them once.
   */
  holdLinkedSecrets(userId: string, deviceId: string, bundle: unknown): void;
  /** Forget the secrets held for this user and device. */
  dropLinkedSecrets(userId: string, deviceId: string): void;
}

export const JS_SDK_CLIENTS = new InjectionToken<JsSdkClients>(
  'JS_SDK_CLIENTS',
  {
    providedIn: 'root',
    factory: () => inject(MatrixClientService),
  },
);
