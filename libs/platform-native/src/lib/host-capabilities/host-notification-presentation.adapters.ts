import { Injectable, Provider, inject } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  HOST_NOTIFICATION_PRESENTATION_OPERATION,
  HostCapabilitiesService,
  type HostCapabilitySupport,
  type HostNotificationPresentationOperation,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  defer,
  from,
  map,
  merge,
  of,
  switchMap,
} from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';

const SILENT_NOTIFICATION_CHANNEL = 'trinity-notifications-silent';

const supported = (): HostCapabilitySupport => ({ kind: 'supported' });
const notSupported = (): Extract<
  HostCapabilitySupport,
  { kind: 'unavailable' }
> => ({ kind: 'unavailable', reason: 'not-supported' });
const completed = (): HostOperationOutcome => ({ kind: 'completed' });
const rejected = (code: string): HostOperationOutcome => ({
  kind: 'rejected',
  diagnostic: { code },
});

@Injectable({ providedIn: 'root' })
export class WebNotificationPresentationAdapter implements HostNotificationPresentationOperation {
  private readonly swPush = inject(SwPush, { optional: true });
  private readonly notificationActivations = new Subject<{
    readonly accountId: string;
    readonly roomId: string;
    readonly eventId: string;
  }>();

  readonly activated = merge(
    this.notificationActivations,
    this.swPush?.notificationClicks.pipe(
      switchMap(({ notification }) => {
        const destination = notification.data;
        return isNotificationDestination(destination) ? of(destination) : EMPTY;
      }),
    ) ?? EMPTY,
  );

  presentationSupport(): Observable<HostCapabilitySupport> {
    return defer(() =>
      of(typeof Notification === 'undefined' ? notSupported() : supported()),
    );
  }

  requestPermission(): Observable<HostOperationOutcome> {
    return defer(() => {
      if (typeof Notification === 'undefined') return of(notSupported());
      if (Notification.permission === 'granted') return of(completed());
      if (Notification.permission === 'denied') {
        return of(rejected('notification-permission-denied'));
      }
      return from(Notification.requestPermission()).pipe(
        map((permission) =>
          permission === 'granted'
            ? completed()
            : rejected('notification-permission-denied'),
        ),
        catchError(() => of(rejected('notification-permission-failed'))),
      );
    });
  }

  present(
    request: Parameters<HostNotificationPresentationOperation['present']>[0],
  ): Observable<HostOperationOutcome> {
    return defer(() => {
      if (
        typeof Notification === 'undefined' ||
        Notification.permission !== 'granted'
      ) {
        return of(notSupported());
      }
      const options: NotificationOptions = {
        body: request.body,
        tag: request.tag,
        silent: request.silent,
        data: request.destination,
      };
      if (navigator.serviceWorker?.controller) {
        return from(navigator.serviceWorker.ready).pipe(
          switchMap((registration) =>
            from(
              Promise.resolve(
                registration.showNotification(request.title, options),
              ),
            ),
          ),
          map(() => completed()),
          catchError(() => this.presentViaConstructor(request, options)),
        );
      }
      return this.presentViaConstructor(request, options);
    });
  }

  private presentViaConstructor(
    request: Parameters<HostNotificationPresentationOperation['present']>[0],
    options: NotificationOptions,
  ): Observable<HostOperationOutcome> {
    try {
      const notification = new Notification(request.title, options);
      notification.onclick = () => {
        this.notificationActivations.next(request.destination);
        notification.close();
      };
      return of(completed());
    } catch {
      return of(rejected('notification-presentation-failed'));
    }
  }
}

@Injectable({ providedIn: 'root' })
export class CapacitorNotificationPresentationAdapter implements HostNotificationPresentationOperation {
  readonly activated = new Observable<{
    readonly accountId: string;
    readonly roomId: string;
    readonly eventId: string;
  }>((subscriber) => {
    if (!this.notificationsAvailable()) {
      subscriber.complete();
      return;
    }
    let handle: PluginListenerHandle | undefined;
    let cancelled = false;
    void LocalNotifications.addListener(
      'localNotificationActionPerformed',
      ({ notification }) => {
        if (isNotificationDestination(notification.extra)) {
          subscriber.next(notification.extra);
        }
      },
    )
      .then((value) => {
        handle = value;
        if (cancelled) void value.remove().catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) subscriber.error(error);
      });
    return () => {
      cancelled = true;
      if (handle) void handle.remove().catch(() => undefined);
    };
  });

  presentationSupport(): Observable<HostCapabilitySupport> {
    return defer(() =>
      of(this.notificationsAvailable() ? supported() : notSupported()),
    );
  }

  requestPermission(): Observable<HostOperationOutcome> {
    return defer(() => {
      if (!this.notificationsAvailable()) return of(notSupported());
      return from(LocalNotifications.checkPermissions()).pipe(
        switchMap(({ display }) =>
          display === 'granted'
            ? of(completed())
            : from(LocalNotifications.requestPermissions()).pipe(
                map((permission) =>
                  permission.display === 'granted'
                    ? completed()
                    : rejected('notification-permission-denied'),
                ),
              ),
        ),
        catchError(() => of(rejected('notification-permission-failed'))),
      );
    });
  }

  present(
    request: Parameters<HostNotificationPresentationOperation['present']>[0],
  ): Observable<HostOperationOutcome> {
    return defer(() => {
      if (!this.notificationsAvailable()) return of(notSupported());
      const prepareSilentChannel =
        request.silent === true && Capacitor.getPlatform() === 'android'
          ? from(
              LocalNotifications.createChannel({
                id: SILENT_NOTIFICATION_CHANNEL,
                name: 'Silent notifications',
                description: 'Message notifications without sound or vibration',
                importance: 3,
                vibration: false,
              }),
            )
          : of(void 0);
      return prepareSilentChannel.pipe(
        switchMap(() =>
          from(
            LocalNotifications.schedule({
              notifications: [
                {
                  id: notificationId(request),
                  title: request.title,
                  body: request.body,
                  extra: request.destination,
                  threadIdentifier: request.tag,
                  group: request.tag,
                  autoCancel: true,
                  foreground: true,
                  isExactNotification: false,
                  ...(request.silent
                    ? Capacitor.getPlatform() === 'android'
                      ? { channelId: SILENT_NOTIFICATION_CHANNEL }
                      : {}
                    : { sound: 'default' }),
                },
              ],
            }),
          ),
        ),
        map(() => completed()),
        catchError(() => of(rejected('notification-presentation-failed'))),
      );
    });
  }

  private notificationsAvailable(): boolean {
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.isPluginAvailable('LocalNotifications')
    );
  }
}

/** Stable signed-31-bit identifier for replacement/click round-trips on Android. */
function notificationId(
  request: Parameters<HostNotificationPresentationOperation['present']>[0],
): number {
  const key = `${request.tag ?? ''}\u0000${request.destination.eventId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff || 1;
}

@Injectable({ providedIn: 'root' })
export class ElectronNotificationPresentationAdapter implements HostNotificationPresentationOperation {
  private readonly capabilities = inject(HostCapabilitiesService);

  readonly activated = new Observable<{
    readonly accountId: string;
    readonly roomId: string;
    readonly eventId: string;
  }>((subscriber) =>
    getTrinityDesktopBridge()?.capabilities.notificationPresentation.subscribeClicks(
      (destination) => subscriber.next(destination),
    ),
  );

  presentationSupport(): Observable<HostCapabilitySupport> {
    return this.capabilities
      .manifest()
      .pipe(
        map((manifest) => manifest.operations['notification-presentation']),
      );
  }

  requestPermission(): Observable<HostOperationOutcome> {
    return defer(() => of(completed()));
  }

  present(
    request: Parameters<HostNotificationPresentationOperation['present']>[0],
  ): Observable<HostOperationOutcome> {
    return defer(() => {
      const bridge = getTrinityDesktopBridge();
      if (!bridge) return of(notSupported());
      return from(
        bridge.capabilities.notificationPresentation.present(request),
      ).pipe(
        map(normalizeElectronNotificationOutcome),
        catchError(() => of(rejected('notification-presentation-failed'))),
      );
    });
  }
}

function normalizeElectronNotificationOutcome(
  value: unknown,
): HostOperationOutcome {
  if (!value || typeof value !== 'object') {
    return rejected('electron-malformed-notification-response');
  }
  const outcome = value as { kind?: unknown; reason?: unknown };
  if (outcome.kind === 'completed') return completed();
  if (
    outcome.kind === 'unavailable' &&
    ['not-supported', 'not-implemented', 'host-rejected'].includes(
      String(outcome.reason),
    )
  ) {
    return {
      kind: 'unavailable',
      reason: outcome.reason as Extract<
        HostOperationOutcome,
        { kind: 'unavailable' }
      >['reason'],
    };
  }
  return rejected('notification-presentation-failed');
}

function isNotificationDestination(value: unknown): value is {
  readonly accountId: string;
  readonly roomId: string;
  readonly eventId: string;
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['accountId'] === 'string' &&
    typeof candidate['roomId'] === 'string' &&
    typeof candidate['eventId'] === 'string'
  );
}

function selectedNotificationPresentationAdapter(): HostNotificationPresentationOperation {
  if (getTrinityDesktopBridge()) {
    return inject(ElectronNotificationPresentationAdapter);
  }
  return Capacitor.isNativePlatform()
    ? inject(CapacitorNotificationPresentationAdapter)
    : inject(WebNotificationPresentationAdapter);
}

export function notificationPresentationProvider(): Provider {
  return {
    provide: HOST_NOTIFICATION_PRESENTATION_OPERATION,
    useFactory: selectedNotificationPresentationAdapter,
  };
}
