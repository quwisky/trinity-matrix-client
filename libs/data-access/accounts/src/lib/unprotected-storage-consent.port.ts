import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

/**
 * App-composed question before a sign-in stores an account's secrets unprotected on disk,
 * because this host's keychain could not be used. Emits true to go ahead.
 */
export interface UnprotectedStorageConsentPort {
  confirm(): Observable<boolean>;
}

export const UNPROTECTED_STORAGE_CONSENT =
  new InjectionToken<UnprotectedStorageConsentPort>(
    'accounts.unprotected-storage-consent',
  );
