import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

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
