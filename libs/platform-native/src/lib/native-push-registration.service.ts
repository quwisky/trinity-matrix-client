import { Injectable } from '@angular/core';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Observable, defer, from, map, of } from 'rxjs';

export type NativePushRegistrationEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'registered'; readonly token: string }
  | { readonly kind: 'registration-failed'; readonly message: string }
  | {
      readonly kind: 'activated';
      readonly data: Readonly<Record<string, unknown>>;
    };

/** Platform adapter for the OS token-registration half of Matrix push. */
@Injectable({ providedIn: 'root' })
export class NativePushRegistrationService {
  readonly platform = nativePushPlatform();

  supported(): boolean {
    return (
      this.platform !== null && Capacitor.isPluginAvailable('PushNotifications')
    );
  }

  requestPermission(): Observable<boolean> {
    return defer(() => {
      if (!this.supported()) return of(false);
      return from(PushNotifications.requestPermissions()).pipe(
        map(({ receive }) => receive === 'granted'),
      );
    });
  }

  prepareChannel(): Observable<void> {
    return defer(() => {
      if (this.platform !== 'android') return of(void 0);
      return from(
        PushNotifications.createChannel({
          id: 'messages',
          name: 'Messages',
          importance: 5,
          visibility: 1,
        }),
      );
    });
  }

  /**
   * Own native push callbacks for exactly one Application Runtime session.
   *
   * Subscription attaches all three listeners and emits `ready` only after their handles
   * resolve, so the registration command cannot race the token callback. Unsubscription
   * removes only these handles; it never clears another consumer's plugin listeners.
   */
  listen(): Observable<NativePushRegistrationEvent> {
    return new Observable((subscriber) => {
      let active = true;
      const handles: PluginListenerHandle[] = [];
      const pending = [
        PushNotifications.addListener('registration', ({ value }) =>
          subscriber.next({ kind: 'registered', token: value }),
        ),
        PushNotifications.addListener('registrationError', ({ error }) =>
          subscriber.next({ kind: 'registration-failed', message: error }),
        ),
        PushNotifications.addListener(
          'pushNotificationActionPerformed',
          (action) => {
            const legacyData = (action as unknown as { data?: unknown }).data;
            const data = action.notification?.data ?? legacyData;
            subscriber.next({
              kind: 'activated',
              data:
                data && typeof data === 'object'
                  ? (data as Readonly<Record<string, unknown>>)
                  : {},
            });
          },
        ),
      ];

      void Promise.allSettled(pending).then((results) => {
        handles.push(
          ...results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
          ),
        );
        const rejected = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (!active) {
          for (const handle of handles) removeListener(handle);
          return;
        }
        if (rejected) {
          subscriber.error(rejected.reason);
          return;
        }
        subscriber.next({ kind: 'ready' });
      });

      return () => {
        active = false;
        for (const handle of handles) removeListener(handle);
      };
    });
  }

  register(): Observable<void> {
    return defer(() => from(PushNotifications.register()));
  }
}

function removeListener(handle: PluginListenerHandle): void {
  void handle.remove().catch(() => undefined);
}

function nativePushPlatform(): 'android' | 'ios' | null {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios' ? platform : null;
}
