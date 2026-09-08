import { Injectable, inject } from '@angular/core';
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Observable, defer, from, map, of } from 'rxjs';
import { NativePushDeliveryService } from './native-push-delivery.service';

export type NativePushRegistrationEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'registered'; readonly token: string }
  | { readonly kind: 'registration-failed'; readonly message: string }
  | {
      readonly kind: 'activated';
      readonly data: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'received';
      readonly data: Readonly<Record<string, unknown>>;
    };

interface NativePushRegistrationPlugin {
  register(): Promise<void>;
}

const nativePushRegistration = registerPlugin<NativePushRegistrationPlugin>(
  'TrinityPushRegistration',
);

/** Platform adapter for the OS token-registration half of Matrix push. */
@Injectable({ providedIn: 'root' })
export class NativePushRegistrationService {
  readonly platform = nativePushPlatform();
  private readonly delivery = inject(NativePushDeliveryService);

  supported(): boolean {
    return (
      this.platform !== null &&
      Capacitor.isPluginAvailable('PushNotifications') &&
      Capacitor.isPluginAvailable('TrinityPushRegistration')
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
   * Subscription attaches all four listeners and emits `ready` only after their handles
   * resolve, so the registration command cannot race the token callback. Unsubscription
   * removes only these handles; it never clears another consumer's plugin listeners.
   */
  listen(): Observable<NativePushRegistrationEvent> {
    return new Observable((subscriber) => {
      let active = true;
      const handles: PluginListenerHandle[] = [];
      const removed = new Set<PluginListenerHandle>();
      const cleanup = (): void => {
        for (const handle of handles) {
          if (removed.has(handle)) continue;
          removed.add(handle);
          removeListener(handle);
        }
      };
      const track = (
        pending: Promise<PluginListenerHandle>,
      ): Promise<PluginListenerHandle> => {
        void pending.then(
          (handle) => {
            if (!active) {
              removeListener(handle);
              return;
            }
            handles.push(handle);
          },
          () => undefined,
        );
        return pending;
      };
      const pending = [
        track(
          PushNotifications.addListener('registration', ({ value }) =>
            subscriber.next({ kind: 'registered', token: value }),
          ),
        ),
        track(
          PushNotifications.addListener('registrationError', ({ error }) =>
            subscriber.next({ kind: 'registration-failed', message: error }),
          ),
        ),
        track(
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
        ),
        track(
          PushNotifications.addListener(
            'pushNotificationReceived',
            (notification) => {
              const data = notification.data;
              subscriber.next({
                kind: 'received',
                data:
                  data && typeof data === 'object'
                    ? (data as Readonly<Record<string, unknown>>)
                    : {},
              });
            },
          ),
        ),
      ];

      void Promise.allSettled(pending).then((results) => {
        const rejected = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (!active) {
          cleanup();
          return;
        }
        if (rejected) {
          cleanup();
          subscriber.error(rejected.reason);
          return;
        }
        subscriber.add(
          this.delivery.foreground('listener').subscribe({
            next: () => subscriber.next({ kind: 'ready' }),
            error: (error: unknown) => {
              cleanup();
              subscriber.error(error);
            },
          }),
        );
      });

      return () => {
        active = false;
        cleanup();
      };
    });
  }

  register(): Observable<void> {
    return defer(() =>
      this.supported() ? from(nativePushRegistration.register()) : of(void 0),
    );
  }
}

function removeListener(handle: PluginListenerHandle): void {
  void handle.remove().catch(() => undefined);
}

function nativePushPlatform(): 'android' | 'ios' | null {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios' ? platform : null;
}
