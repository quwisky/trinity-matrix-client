import { Injectable, Provider, inject } from '@angular/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_BACK_OPERATION,
  HOST_DEEP_LINKS_OPERATION,
  HOST_NOTIFICATION_PRESENTATION_OPERATION,
  HostCapabilitiesService,
  type HostAuthenticationHandoffOperation,
  type HostBackOperation,
  type HostCapabilitySupport,
  type HostDeepLinksOperation,
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
  of,
  switchMap,
} from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';

type HostOperationsAdapter = HostAuthenticationHandoffOperation &
  HostDeepLinksOperation &
  HostBackOperation &
  HostNotificationPresentationOperation;

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
export class WebHostOperationAdapter implements HostOperationsAdapter {
  private readonly notificationActivations = new Subject<{
    readonly roomId: string;
    readonly userId?: string;
  }>();

  callback(request: { readonly webUrl: string; readonly appUrl: string }) {
    return { url: request.webUrl, applicationType: 'web' as const };
  }

  open(request: { readonly url: string }): Observable<HostOperationOutcome> {
    return defer(() => {
      window.location.href = request.url;
      return of(completed());
    });
  }

  readonly received = EMPTY;
  readonly intents = EMPTY;
  readonly activated = this.notificationActivations.asObservable();

  deepLinkSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(notSupported()));
  }

  backSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(notSupported()));
  }

  presentationSupport(): Observable<HostCapabilitySupport> {
    return defer(() =>
      of(typeof Notification === 'undefined' ? notSupported() : supported()),
    );
  }

  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }

  background(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }

  requestPermission(): Observable<HostOperationOutcome> {
    return defer(() => {
      if (typeof Notification === 'undefined') return of(notSupported());
      if (Notification.permission !== 'default') return of(completed());
      return from(Notification.requestPermission()).pipe(
        map(() => completed()),
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
        data: { roomId: request.roomId, userId: request.userId },
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
        this.notificationActivations.next({
          roomId: request.roomId,
          ...(request.userId ? { userId: request.userId } : {}),
        });
        notification.close();
      };
      return of(completed());
    } catch {
      return of(rejected('notification-presentation-failed'));
    }
  }
}

@Injectable({ providedIn: 'root' })
export class CapacitorHostOperationAdapter implements HostOperationsAdapter {
  callback(request: { readonly webUrl: string; readonly appUrl: string }) {
    return { url: request.appUrl, applicationType: 'native' as const };
  }

  open(request: { readonly url: string }): Observable<HostOperationOutcome> {
    return defer(() => from(Browser.open({ url: request.url }))).pipe(
      map(() => completed()),
      catchError(() => of(rejected('authentication-handoff-failed'))),
    );
  }

  readonly received = new Observable<{ readonly url: string }>((subscriber) => {
    let handle: PluginListenerHandle | undefined;
    let cancelled = false;
    void App.addListener('appUrlOpen', (event) =>
      subscriber.next({ url: event.url }),
    )
      .then((value) => {
        handle = value;
        if (cancelled) void value.remove().catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) subscriber.error(error);
      });
    void App.getLaunchUrl()
      .then((launch) => {
        if (launch?.url) subscriber.next({ url: launch.url });
      })
      .catch((error: unknown) => {
        if (!cancelled) subscriber.error(error);
      });
    return () => {
      cancelled = true;
      if (handle) void handle.remove().catch(() => undefined);
    };
  });

  readonly intents = new Observable<{ readonly canGoBack: boolean }>(
    (subscriber) => {
      let handle: PluginListenerHandle | undefined;
      let cancelled = false;
      void App.addListener('backButton', (event) =>
        subscriber.next({ canGoBack: event.canGoBack }),
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
    },
  );
  readonly activated = EMPTY;

  deepLinkSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(supported()));
  }
  backSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(supported()));
  }
  presentationSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(notSupported()));
  }
  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(() => from(Browser.close())).pipe(
      map(() => completed()),
      catchError(() => of(notSupported())),
    );
  }
  background(): Observable<HostOperationOutcome> {
    return defer(() => from(App.minimizeApp())).pipe(
      map(() => completed()),
      catchError(() => of(rejected('background-failed'))),
    );
  }
  requestPermission(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
  present(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
}

@Injectable({ providedIn: 'root' })
export class ElectronHostOperationAdapter implements HostOperationsAdapter {
  private readonly capabilities = inject(HostCapabilitiesService);

  callback(request: { readonly webUrl: string; readonly appUrl: string }) {
    return { url: request.appUrl, applicationType: 'native' as const };
  }
  open(request: { readonly url: string }): Observable<HostOperationOutcome> {
    return defer(() => {
      window.open(request.url, '_blank');
      return of(completed());
    });
  }
  readonly received = new Observable<{ readonly url: string }>((subscriber) =>
    getTrinityDesktopBridge()?.capabilities.deepLinks.subscribe((url) =>
      subscriber.next({ url }),
    ),
  );
  readonly intents = EMPTY;
  readonly activated = new Observable<{
    readonly roomId: string;
    readonly userId?: string;
  }>((subscriber) =>
    getTrinityDesktopBridge()?.capabilities.notificationPresentation.subscribeClicks(
      (roomId, userId) =>
        subscriber.next({ roomId, ...(userId ? { userId } : {}) }),
    ),
  );

  deepLinkSupport(): Observable<HostCapabilitySupport> {
    return this.capabilities
      .manifest()
      .pipe(map((manifest) => manifest.operations['deep-links']));
  }
  backSupport(): Observable<HostCapabilitySupport> {
    return this.capabilities
      .manifest()
      .pipe(map((manifest) => manifest.operations.back));
  }
  presentationSupport(): Observable<HostCapabilitySupport> {
    return this.capabilities
      .manifest()
      .pipe(
        map((manifest) => manifest.operations['notification-presentation']),
      );
  }
  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
  background(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
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
      bridge.capabilities.notificationPresentation.present(request);
      return of(completed());
    });
  }
}

function selectedHostOperationAdapter(): HostOperationsAdapter {
  if (getTrinityDesktopBridge()) return inject(ElectronHostOperationAdapter);
  return Capacitor.isNativePlatform()
    ? inject(CapacitorHostOperationAdapter)
    : inject(WebHostOperationAdapter);
}

export function hostOperationProviders(): Provider[] {
  return [
    HOST_AUTHENTICATION_HANDOFF_OPERATION,
    HOST_DEEP_LINKS_OPERATION,
    HOST_BACK_OPERATION,
    HOST_NOTIFICATION_PRESENTATION_OPERATION,
  ].map((provide) => ({ provide, useFactory: selectedHostOperationAdapter }));
}
