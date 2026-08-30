import { DOCUMENT } from '@angular/common';
import { Injectable, Provider, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_BACK_OPERATION,
  HOST_DEEP_LINKS_OPERATION,
  HOST_FILE_EXPORT_OPERATION,
  HOST_LIFECYCLE_OPERATION,
  HOST_UPDATES_OPERATION,
  HostCapabilitiesService,
  type HostAuthenticationHandoffOperation,
  type HostBackOperation,
  type HostCapabilitySupport,
  type HostDeepLinksOperation,
  type HostFileExportOperation,
  type HostLifecycleOperation,
  type HostOperationOutcome,
  type HostUpdatesOperation,
} from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  distinctUntilChanged,
  from,
  fromEvent,
  map,
  of,
  switchMap,
} from 'rxjs';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import { FileSaveService } from '../host-media/file-save.service';
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
  readonly received = defer(() => this.deepLinkSupport()).pipe(
    switchMap((support) =>
      support.kind === 'supported'
        ? new Observable<{ readonly url: string }>((subscriber) =>
            getTrinityDesktopBridge()?.capabilities.deepLinks.subscribe((url) =>
              subscriber.next({ url }),
            ),
          )
        : EMPTY,
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

@Injectable({ providedIn: 'root' })
export class HostFileExportAdapter implements HostFileExportOperation {
  private readonly capabilities = inject(HostCapabilitiesService);
  private readonly files = inject(FileSaveService);

  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.capabilities.manifest()).pipe(
      map((manifest) => manifest.operations['file-export']),
    );
  }

  save(
    request: Parameters<HostFileExportOperation['save']>[0],
  ): Observable<HostOperationOutcome> {
    return this.support().pipe(
      switchMap((support) =>
        support.kind === 'unavailable'
          ? of(support)
          : this.files.save(request.bytes, request.filename).pipe(
              map(() => completed()),
              catchError(() => of(rejected('file-export-failed'))),
            ),
      ),
    );
  }
}

@Injectable({ providedIn: 'root' })
export class DocumentHostLifecycleAdapter implements HostLifecycleOperation {
  private readonly document = inject(DOCUMENT);

  readonly events = defer(() =>
    fromEvent(this.document, 'visibilitychange').pipe(
      map(() =>
        this.document.visibilityState === 'visible'
          ? ({ kind: 'active' } as const)
          : ({ kind: 'background' } as const),
      ),
      distinctUntilChanged(
        (previous, current) => previous.kind === current.kind,
      ),
    ),
  );
}

@Injectable({ providedIn: 'root' })
export class ServiceWorkerHostUpdatesAdapter implements HostUpdatesOperation {
  private readonly updates = inject(SwUpdate, { optional: true });

  support(): Observable<HostCapabilitySupport> {
    return defer(() =>
      of(this.updates?.isEnabled ? supported() : notSupported()),
    );
  }

  check(): Observable<HostOperationOutcome> {
    return this.support().pipe(
      switchMap((support) =>
        support.kind === 'unavailable'
          ? of(support)
          : from(this.updates!.checkForUpdate()).pipe(
              map(() => completed()),
              catchError(() => of(rejected('update-check-failed'))),
            ),
      ),
    );
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
    { provide: HOST_FILE_EXPORT_OPERATION, useExisting: HostFileExportAdapter },
    {
      provide: HOST_LIFECYCLE_OPERATION,
      useExisting: DocumentHostLifecycleAdapter,
    },
    {
      provide: HOST_UPDATES_OPERATION,
      useExisting: ServiceWorkerHostUpdatesAdapter,
    },
    notificationPresentationProvider(),
  ];
}
