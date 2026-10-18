import { Injectable, inject } from '@angular/core';
import { SecureStorageService } from '@trinity/platform-native';
import {
  defaultIfEmpty,
  defer,
  map,
  of,
  switchMap,
  take,
  type Observable,
} from 'rxjs';
import { UNPROTECTED_STORAGE_CONSENT } from './unprotected-storage-consent.port';

/**
 * Whether a sign-in may store its secrets here: always where the keychain works, and
 * otherwise only once this device's person agreed. Asked once per device; the answer is
 * stored with the device's other settings.
 */
@Injectable({ providedIn: 'root' })
export class UnprotectedStorageGate {
  private readonly secure = inject(SecureStorageService);
  /** Unbound means no one can be asked, so storing without a keychain is declined. */
  private readonly consent = inject(UNPROTECTED_STORAGE_CONSENT, {
    optional: true,
  });

  /** Cold; emits once. A failed read of the stored answer errors. */
  allowed(): Observable<boolean> {
    return defer(async () =>
      (await this.secure.withoutKeychain())
        ? (await this.secure.unprotectedStorageAcknowledged()) !== 'consented'
        : false,
    ).pipe(
      switchMap((ask) =>
        !ask
          ? of(true)
          : (this.consent?.confirm() ?? of(false)).pipe(
              take(1),
              defaultIfEmpty(false),
              switchMap((agreed) =>
                agreed
                  ? defer(() =>
                      this.secure.acknowledgeUnprotectedStorage('consented'),
                    ).pipe(map(() => true))
                  : of(false),
              ),
            ),
      ),
    );
  }
}
