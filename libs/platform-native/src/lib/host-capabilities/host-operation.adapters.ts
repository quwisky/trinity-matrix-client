import { DOCUMENT } from '@angular/common';
import { Injectable, Provider, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  authSessionAvailable,
  startAuthSession,
} from '@trinity/capacitor-auth-session';
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
  type HostFileExportOutcome,
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
  Subject,
  switchMap,
  take,
  timeout,
} from 'rxjs';
import {
  desktopAppIdentity,
  getTrinityDesktopBridge,
} from '../trinity-desktop-bridge';
import { browserSheetClosed } from '../browser-sheet-closed';
import { FileSaveService } from '../host-media/file-save.service';
import { notificationPresentationProvider } from './host-notification-presentation.adapters';
import { userPresenceProvider } from './host-user-presence.adapters';
import { lockIntegrationProvider } from './host-lock-integration.adapters';
import { screenPrivacyProvider } from './host-screen-privacy.adapters';

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
const HOST_UPDATE_CHECK_TIMEOUT_MS = 5_000;

/** The scheme sign-in callbacks and app links are written in on every host. */
const CANONICAL_APP_SCHEME = 'dev.trinityproject.trinity';

/** An app URL moved onto the scheme this desktop app registered (Trinity Next has its own). */
function desktopAppUrl(appUrl: string): string {
  const { deepLinkScheme } = desktopAppIdentity(getTrinityDesktopBridge());
  if (!appUrl.startsWith(`${CANONICAL_APP_SCHEME}:`)) {
    throw new Error('A sign-in callback must use the Trinity app scheme.');
  }
  return `${deepLinkScheme}${appUrl.slice(CANONICAL_APP_SCHEME.length)}`;
}

/**
 * A link the shell delivered, moved back onto the scheme the renderer's parsers know, or
 * null for stable Trinity's link arriving in Trinity Next. Main already forwards only this
 * app's own scheme (electron/src/deep-link.ts); dropping it here is defence in depth.
 */
function canonicalAppUrl(url: string): string | null {
  const scheme = getTrinityDesktopBridge()?.appIdentity?.deepLinkScheme;
  if (!scheme || scheme === CANONICAL_APP_SCHEME) return url;
  if (url.startsWith(`${scheme}:`)) {
    return `${CANONICAL_APP_SCHEME}${url.slice(scheme.length)}`;
  }
  return url.startsWith(`${CANONICAL_APP_SCHEME}:`) ? null : url;
}

/**
 * A legacy SSO login token comes back on mobile only from the iOS authentication session; one
 * on the app scheme was sent by whichever app opened it, so the link is dropped unread.
 */
function carriesLoginToken(url: string): boolean {
  try {
    return new URL(url).searchParams.has('loginToken');
  } catch {
    return false;
  }
}

@Injectable({ providedIn: 'root' })
class WebHostOperationAdapter implements HostOperationsAdapter {
  callback(request: { readonly webUrl: string; readonly appUrl: string }) {
    return { url: request.webUrl, applicationType: 'web' as const };
  }

  /** The callback is a page of this origin. */
  privateCallbackSupported(): boolean {
    return true;
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
  /** Callbacks an iOS authentication session returned, which never pass through `appUrlOpen`. */
  private readonly sessionCallbacks = new Subject<{ readonly url: string }>();

  callback(request: { readonly webUrl: string; readonly appUrl: string }) {
    return { url: request.appUrl, applicationType: 'native' as const };
  }

  /** iOS only: Android has no session API that returns the callback to the app that asked. */
  privateCallbackSupported(): boolean {
    return authSessionAvailable();
  }

  open(request: {
    readonly url: string;
    readonly privateCallback?: boolean;
  }): Observable<HostOperationOutcome> {
    if (request.privateCallback) {
      return startAuthSession({
        url: request.url,
        callbackScheme: CANONICAL_APP_SCHEME,
      }).pipe(
        map((outcome) => {
          if (outcome.kind === 'completed') {
            this.sessionCallbacks.next({ url: outcome.url });
            return completed();
          }
          return rejected(
            outcome.kind === 'cancelled'
              ? 'authentication-cancelled'
              : 'authentication-session-unavailable',
          );
        }),
      );
    }
    return defer(() => from(Browser.open({ url: request.url }))).pipe(
      map(() => completed()),
      catchError(() => of(rejected('authentication-handoff-failed'))),
    );
  }

  /** Custom Tabs and the Safari View Controller are the app's own sheet. */
  readonly sheetClosed = browserSheetClosed;

  /**
   * The launch URL describes the process start; re-attached listeners must not replay it.
   * Also set once an `appUrlOpen` has delivered a link.
   */
  private launchUrlTaken = false;

  readonly received = new Observable<{ readonly url: string }>((subscriber) => {
    let handle: PluginListenerHandle | undefined;
    let cancelled = false;
    const fromSession = this.sessionCallbacks.subscribe((link) =>
      subscriber.next(link),
    );
    void App.addListener('appUrlOpen', (event) => {
      // Capacitor flushes a retained launch `appUrlOpen` synchronously on the first
      // addListener, which is issued before getLaunchUrl, so skip getLaunchUrl once one landed.
      this.launchUrlTaken = true;
      if (!carriesLoginToken(event.url)) subscriber.next({ url: event.url });
    })
      .then((value) => {
        handle = value;
        if (cancelled) void value.remove().catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) subscriber.error(error);
      });
    void App.getLaunchUrl()
      .then((launch) => {
        if (cancelled || !launch?.url || this.launchUrlTaken) return;
        this.launchUrlTaken = true;
        if (!carriesLoginToken(launch.url))
          subscriber.next({ url: launch.url });
      })
      .catch((error: unknown) => {
        if (!cancelled) subscriber.error(error);
      });
    return () => {
      cancelled = true;
      fromSession.unsubscribe();
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
class ElectronHostOperationAdapter implements HostOperationsAdapter {
  private readonly capabilities = inject(HostCapabilitiesService);

  callback(request: { readonly webUrl: string; readonly appUrl: string }) {
    return {
      url: desktopAppUrl(request.appUrl),
      applicationType: 'native' as const,
    };
  }
  /** Only software already running as the user could claim the desktop scheme. */
  privateCallbackSupported(): boolean {
    return true;
  }
  deviceDisplayName(): string {
    return desktopAppIdentity(getTrinityDesktopBridge()).displayName;
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
            getTrinityDesktopBridge()?.capabilities.deepLinks.subscribe(
              (url) => {
                const appUrl = canonicalAppUrl(url);
                if (appUrl !== null) subscriber.next({ url: appUrl });
              },
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
  ): Observable<HostFileExportOutcome> {
    return this.support().pipe(
      switchMap((support) =>
        support.kind === 'unavailable'
          ? of(support)
          : this.files.save(request.bytes, request.filename).pipe(
              map((result): HostFileExportOutcome =>
                result === 'cancelled' ? { kind: 'cancelled' } : completed(),
              ),
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

/**
 * The shell keeps `backgroundThrottling` off so `/sync` runs while hidden, which also pins
 * `document.visibilityState` to `visible`. Main reports the window's own visibility instead.
 */
@Injectable({ providedIn: 'root' })
export class ElectronHostLifecycleAdapter implements HostLifecycleOperation {
  private readonly capabilities = inject(HostCapabilitiesService);

  private readonly support = defer(() => this.capabilities.manifest()).pipe(
    map((manifest) => manifest.operations.lifecycle),
  );

  readonly events = this.support.pipe(
    switchMap((support) =>
      support.kind === 'supported'
        ? new Observable<'visible' | 'hidden'>((subscriber) =>
            getTrinityDesktopBridge()?.capabilities.lifecycle.subscribeVisibility(
              (visibility) => subscriber.next(visibility),
            ),
          )
        : EMPTY,
    ),
    distinctUntilChanged(),
    map((visibility) =>
      visibility === 'visible'
        ? ({ kind: 'active' } as const)
        : ({ kind: 'background' } as const),
    ),
  );

  releaseMemory(): Observable<HostOperationOutcome> {
    return this.support.pipe(
      take(1),
      map((support) => {
        if (support.kind === 'unavailable') return support;
        getTrinityDesktopBridge()?.capabilities.lifecycle.releaseMemory();
        return completed();
      }),
    );
  }
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
              // A blocked or broken service-worker registration can leave Angular's
              // update promise pending forever. Host commands must remain cold and finite.
              timeout({
                first: HOST_UPDATE_CHECK_TIMEOUT_MS,
                with: () => of(rejected('update-check-timeout')),
              }),
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
      useFactory: (): HostLifecycleOperation =>
        getTrinityDesktopBridge()
          ? inject(ElectronHostLifecycleAdapter)
          : inject(DocumentHostLifecycleAdapter),
    },
    {
      provide: HOST_UPDATES_OPERATION,
      useExisting: ServiceWorkerHostUpdatesAdapter,
    },
    notificationPresentationProvider(),
    userPresenceProvider(),
    lockIntegrationProvider(),
    screenPrivacyProvider(),
  ];
}
