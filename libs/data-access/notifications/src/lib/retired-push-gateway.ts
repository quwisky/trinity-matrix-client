import { Injectable, inject } from '@angular/core';
import { DevicePreferenceStorageService } from '@trinity/platform-native';
import { Observable, catchError, of } from 'rxjs';

/**
 * What the retired Settings → Notifications → Push gateway setting stored: the device
 * override and the ledger of the app id its pushers were registered under. The gateway is
 * now build configuration, so nothing reads either key.
 */
export const RETIRED_PUSH_GATEWAY_KEYS = [
  'trinity.push.gateway',
  'trinity.push.applied-app-id',
] as const;

/** Deletes {@link RETIRED_PUSH_GATEWAY_KEYS} once per startup. */
@Injectable({ providedIn: 'root' })
export class RetiredPushGatewayCleanup {
  private readonly storage = inject(DevicePreferenceStorageService);

  /** Cold and finite. A storage failure is ignored: the next launch tries again. */
  run(): Observable<void> {
    return this.storage
      .removeMany(RETIRED_PUSH_GATEWAY_KEYS)
      .pipe(catchError(() => of(void 0)));
  }
}
