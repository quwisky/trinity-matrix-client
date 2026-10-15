import { Injectable, Provider, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  PrivacyScreen,
  type PrivacyScreenConfig,
} from '@capacitor/privacy-screen';
import { AppLockPinBridge } from '@trinity/capacitor-app-lock';
import {
  HOST_SCREEN_PRIVACY_OPERATION,
  HostDeepLinksService,
  type HostOperationOutcome,
  type HostScreenPrivacyOperation,
  type HostScreenPrivacySupport,
} from '@trinity/runtime/host';
import {
  Observable,
  catchError,
  concatMap,
  defaultIfEmpty,
  defer,
  from,
  map,
  of,
  take,
} from 'rxjs';
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
  private readonly deepLinks = inject(HostDeepLinksService);

  /** Android's FLAG_SECURE also blocks capture; the iOS blur only covers the snapshot. */
  support(): Observable<HostScreenPrivacySupport> {
    return defer(() =>
      of<HostScreenPrivacySupport>(
        Capacitor.isPluginAvailable(PRIVACY_SCREEN_PLUGIN)
          ? {
              kind: 'supported',
              blocksCapture: Capacitor.getPlatform() === 'android',
            }
          : { kind: 'unavailable', reason: 'not-supported' },
      ),
    );
  }

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

  /**
   * Best effort: a failure or a timeout is reported, never thrown. On Android a Custom Tab is
   * its own activity, out of the bridge's reach, so it is closed through the browser sheet's
   * own close too; Android 10 and later refuse that while Trinity is in the background. Not on
   * iOS, where the Browser plugin's close dismisses whatever the root presents, the privacy
   * cover included, and the bridge's dismissal already takes the browser sheet down.
   */
  dismissPresented(): Observable<HostOperationOutcome> {
    return defer(() =>
      Capacitor.getPlatform() === 'android'
        ? this.dismissal().pipe(
            concatMap((outcome) =>
              this.closeCustomTab().pipe(map(() => outcome)),
            ),
          )
        : this.dismissal(),
    );
  }

  private closeCustomTab(): Observable<unknown> {
    return this.deepLinks.closeAuthentication().pipe(
      take(1),
      defaultIfEmpty(null),
      catchError(() => of(null)),
    );
  }

  private dismissal(): Observable<HostOperationOutcome> {
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
