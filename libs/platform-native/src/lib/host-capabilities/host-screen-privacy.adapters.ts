import { Injectable, Provider, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  PrivacyScreen,
  type PrivacyScreenConfig,
} from '@capacitor/privacy-screen';
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

/**
 * iOS blurs the app-switcher snapshot (spec §4). Android dims rather than drawing the splash,
 * whose path looks up a `Splash` theme Trinity doesn't have; FLAG_SECURE is set either way.
 */
const COVER = {
  ios: { blurEffect: 'dark' },
  android: { dimBackground: true },
} as const satisfies PrivacyScreenConfig;

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
        enabled ? PrivacyScreen.enable(COVER) : PrivacyScreen.disable(),
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

  /** Best effort: a failure or a timeout is reported, never thrown. */
  dismissPresented(): Observable<HostOperationOutcome> {
    return defer(() => this.appLock.dismissPresented()).pipe(
      map((dismissal): HostOperationOutcome => {
        switch (dismissal) {
          case 'completed':
            return { kind: 'completed' };
          case 'failed':
            return { kind: 'rejected', diagnostic: { code: 'dismiss-failed' } };
          case 'timed-out':
            return {
              kind: 'rejected',
              diagnostic: { code: 'dismiss-timeout' },
            };
          case 'unavailable':
            return NOT_SUPPORTED;
          default: {
            const unhandled: never = dismissal;
            void unhandled;
            return { kind: 'rejected', diagnostic: { code: 'dismiss-failed' } };
          }
        }
      }),
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
