import { Injectable, Provider, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { PrivacyScreen } from '@capacitor/privacy-screen';
import { AppLockPinBridge } from '@trinity/capacitor-app-lock';
import {
  HOST_SCREEN_PRIVACY_OPERATION,
  type HostOperationOutcome,
  type HostScreenPrivacyOperation,
} from '@trinity/runtime/host';
import { Observable, catchError, defer, from, map, of } from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';

/** The name `@capacitor/privacy-screen` registers in both native hosts. */
export const PRIVACY_SCREEN_PLUGIN = 'PrivacyScreen';

const FAILED: HostOperationOutcome = {
  kind: 'rejected',
  diagnostic: { code: 'screen-privacy-failed' },
};

const NOT_SUPPORTED: HostOperationOutcome = {
  kind: 'unavailable',
  reason: 'not-supported',
};

/**
 * The app-switcher cover while App lock is on (decision 13): iOS covers the snapshot on
 * resign-active, Android sets FLAG_SECURE. Fails closed: a host without the plugin is
 * unavailable, and a refusal or an answer outside the declared shape is rejected.
 */
@Injectable({ providedIn: 'root' })
export class CapacitorScreenPrivacyAdapter implements HostScreenPrivacyOperation {
  private readonly appLock = inject(AppLockPinBridge);

  set(enabled: boolean): Observable<HostOperationOutcome> {
    return defer(() => {
      if (!Capacitor.isPluginAvailable(PRIVACY_SCREEN_PLUGIN)) {
        return of(NOT_SUPPORTED);
      }
      return from(
        enabled ? PrivacyScreen.enable() : PrivacyScreen.disable(),
      ).pipe(
        map((result: unknown): HostOperationOutcome =>
          typeof result === 'object' &&
          result !== null &&
          (result as { success?: unknown }).success === true
            ? { kind: 'completed' }
            : FAILED,
        ),
        catchError(() => of(FAILED)),
      );
    });
  }

  dismissPresented(): Observable<HostOperationOutcome> {
    return defer(() => this.appLock.dismissPresented()).pipe(
      map((): HostOperationOutcome => ({ kind: 'completed' })),
    );
  }
}

/** Only iOS and Android have an app-switcher cover; other hosts provide null. */
export function screenPrivacyProvider(): Provider {
  return {
    provide: HOST_SCREEN_PRIVACY_OPERATION,
    useFactory: (): HostScreenPrivacyOperation | null =>
      Capacitor.isNativePlatform() && !getTrinityDesktopBridge()
        ? inject(CapacitorScreenPrivacyAdapter)
        : null,
  };
}
