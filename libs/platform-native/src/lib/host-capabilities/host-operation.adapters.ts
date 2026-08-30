import { Injectable, Provider, inject } from '@angular/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_BACK_OPERATION,
  HOST_DEEP_LINKS_OPERATION,
  HostCapabilitiesService,
  type HostAuthenticationHandoffOperation,
  type HostBackOperation,
  type HostCapabilitySupport,
  type HostDeepLinksOperation,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { EMPTY, Observable, catchError, defer, from, map, of } from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import { notificationPresentationProvider } from './host-notification-presentation.adapters';

type HostOperationsAdapter = HostAuthenticationHandoffOperation &
  HostDeepLinksOperation &
  HostBackOperation;

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

  deepLinkSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(notSupported()));
  }

  backSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(notSupported()));
  }

  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }

  background(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
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

  readonly intents = defer(() =>
    Capacitor.getPlatform() === 'android'
      ? new Observable<{ readonly canGoBack: boolean }>((subscriber) => {
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
        })
      : EMPTY,
  );
  deepLinkSupport(): Observable<HostCapabilitySupport> {
    return defer(() => of(supported()));
  }
  backSupport(): Observable<HostCapabilitySupport> {
    return defer(() =>
      of(Capacitor.getPlatform() === 'android' ? supported() : notSupported()),
    );
  }
  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(() => from(Browser.close())).pipe(
      map(() => completed()),
      catchError(() => of(notSupported())),
    );
  }
  background(): Observable<HostOperationOutcome> {
    return defer(() =>
      Capacitor.getPlatform() === 'android'
        ? from(App.minimizeApp()).pipe(
            map(() => completed()),
            catchError(() => of(rejected('background-failed'))),
          )
        : of(notSupported()),
    );
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
  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
  }
  background(): Observable<HostOperationOutcome> {
    return defer(() => of(notSupported()));
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
    ...[
      HOST_AUTHENTICATION_HANDOFF_OPERATION,
      HOST_DEEP_LINKS_OPERATION,
      HOST_BACK_OPERATION,
    ].map((provide) => ({ provide, useFactory: selectedHostOperationAdapter })),
    notificationPresentationProvider(),
  ];
}
