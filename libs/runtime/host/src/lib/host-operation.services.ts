import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  EMPTY,
  NEVER,
  Observable,
  Subscription,
  defer,
  filter,
  finalize,
  merge,
  of,
  takeUntil,
  tap,
} from 'rxjs';
import {
  type HostAuthenticationHandoffOperation,
  type HostBackOperation,
  type HostDeepLinksOperation,
  type HostNotificationPresentationOperation,
  type HostCapabilitySupport,
  type HostFileExportOperation,
  type HostFileExportOutcome,
  type HostLifecycleOperation,
  type HostLockIntegrationOperation,
  type HostLockRequest,
  type HostLockState,
  type HostOperationOutcome,
  type HostPinOutcome,
  type HostPresenceOutcome,
  type HostScreenPrivacyOperation,
  type HostScreenPrivacySupport,
  type HostUpdatesOperation,
  type HostUserPresenceOperation,
  type HostUserPresenceSupport,
} from './host-capability.models';
import { HostSystemUiService } from './host-system-ui.service';

export const HOST_AUTHENTICATION_HANDOFF_OPERATION =
  new InjectionToken<HostAuthenticationHandoffOperation>(
    'HOST_AUTHENTICATION_HANDOFF_OPERATION',
  );
export const HOST_DEEP_LINKS_OPERATION =
  new InjectionToken<HostDeepLinksOperation>('HOST_DEEP_LINKS_OPERATION');
export const HOST_BACK_OPERATION = new InjectionToken<HostBackOperation>(
  'HOST_BACK_OPERATION',
);
export const HOST_FILE_EXPORT_OPERATION =
  new InjectionToken<HostFileExportOperation>('HOST_FILE_EXPORT_OPERATION');
export const HOST_NOTIFICATION_PRESENTATION_OPERATION =
  new InjectionToken<HostNotificationPresentationOperation>(
    'HOST_NOTIFICATION_PRESENTATION_OPERATION',
  );
export const HOST_LIFECYCLE_OPERATION =
  new InjectionToken<HostLifecycleOperation>('HOST_LIFECYCLE_OPERATION');
export const HOST_UPDATES_OPERATION = new InjectionToken<HostUpdatesOperation>(
  'HOST_UPDATES_OPERATION',
);
export const HOST_USER_PRESENCE_OPERATION =
  new InjectionToken<HostUserPresenceOperation>('HOST_USER_PRESENCE_OPERATION');
/** Null where the host has no lock integration (everything but Electron). */
export const HOST_LOCK_INTEGRATION_OPERATION =
  new InjectionToken<HostLockIntegrationOperation | null>(
    'HOST_LOCK_INTEGRATION_OPERATION',
  );
/** Null where the host has no app-switcher cover (web, Electron). */
export const HOST_SCREEN_PRIVACY_OPERATION =
  new InjectionToken<HostScreenPrivacyOperation | null>(
    'HOST_SCREEN_PRIVACY_OPERATION',
  );

/** Neither a system prompt nor a PIN: App lock is not offered. */
export const NO_USER_PRESENCE: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'unavailable', reason: 'not-supported' },
};

const unavailableSupport = (): Extract<
  HostCapabilitySupport,
  { kind: 'unavailable' }
> => ({
  kind: 'unavailable',
  reason: 'not-supported',
});
const unavailableOutcome = (): HostOperationOutcome => unavailableSupport();

/** What a new Matrix device is called when the host does not name it. */
const DEFAULT_DEVICE_DISPLAY_NAME = 'Trinity';

/**
 * Trinity's in-app browser sheet (Custom Tabs, Safari View Controller) as its own system UI,
 * so App lock never locks behind it: sign-in, and the account provider's pages opened from
 * Settings or an identity reset. The host shows one sheet at a time, so they share one count.
 * It runs from the moment the sheet opens until the first of: a link arriving back, Trinity
 * closing the sheet, `closed` (the host reporting the person closed it), or the app returning
 * to the foreground, which also ends a count whose other ends were missed.
 */
@Injectable({ providedIn: 'root' })
export class HostBrowserSheetService {
  private readonly systemUi = inject(HostSystemUiService);
  private readonly lifecycle = inject(HostLifecycleService);
  private span: Subscription | null = null;

  /** A sheet is opening; a sheet still counted is replaced. */
  begin(closed: Observable<unknown>): void {
    this.end();
    const back = this.lifecycle.events.pipe(
      filter((event) => event.kind === 'active'),
    );
    this.span = this.systemUi
      .track(NEVER)
      .pipe(takeUntil(merge(closed, back)))
      .subscribe();
  }

  /** The sheet has closed, or never opened. */
  end(): void {
    this.span?.unsubscribe();
    this.span = null;
  }
}

@Injectable({ providedIn: 'root' })
export class HostAuthenticationHandoffService implements HostAuthenticationHandoffOperation {
  private readonly adapter = inject(HOST_AUTHENTICATION_HANDOFF_OPERATION, {
    optional: true,
  });
  private readonly sheet = inject(HostBrowserSheetService);

  callback(request: { readonly webUrl: string; readonly appUrl: string }): {
    readonly url: string;
    readonly applicationType: 'web' | 'native';
  } {
    return (
      this.adapter?.callback(request) ?? {
        url: request.webUrl,
        applicationType: 'web',
      }
    );
  }

  privateCallbackSupported(): boolean {
    return this.adapter?.privateCallbackSupported() ?? false;
  }

  open(request: {
    readonly url: string;
    readonly privateCallback?: boolean;
  }): Observable<HostOperationOutcome> {
    const adapter = this.adapter;
    if (!adapter) return defer(() => of(unavailableOutcome()));
    const closed = adapter.sheetClosed;
    if (!closed) return adapter.open(request);
    return defer(() => {
      // From before the sheet shows: the host's open resolves only once it is up.
      this.sheet.begin(closed);
      return adapter.open(request).pipe(
        tap({
          next: (outcome) => {
            if (outcome.kind !== 'completed') this.sheet.end();
          },
          error: () => this.sheet.end(),
        }),
      );
    });
  }

  deviceDisplayName(): string {
    return this.adapter?.deviceDisplayName?.() ?? DEFAULT_DEVICE_DISPLAY_NAME;
  }
}

@Injectable({ providedIn: 'root' })
export class HostDeepLinksService {
  private readonly adapter = inject(HOST_DEEP_LINKS_OPERATION, {
    optional: true,
  });
  private readonly sheet = inject(HostBrowserSheetService);

  support(): Observable<HostCapabilitySupport> {
    return (
      this.adapter?.deepLinkSupport() ?? defer(() => of(unavailableSupport()))
    );
  }

  /** A link arriving back (the sign-in callback among them) ends a sign-in sheet's count. */
  readonly received = defer(() => this.adapter?.received ?? EMPTY).pipe(
    tap(() => this.sheet.end()),
  );

  closeAuthentication(): Observable<HostOperationOutcome> {
    return defer(
      () => this.adapter?.closeAuthentication() ?? of(unavailableOutcome()),
    ).pipe(finalize(() => this.sheet.end()));
  }
}

@Injectable({ providedIn: 'root' })
export class HostBackService {
  private readonly adapter = inject(HOST_BACK_OPERATION, { optional: true });

  support(): Observable<HostCapabilitySupport> {
    return this.adapter?.backSupport() ?? defer(() => of(unavailableSupport()));
  }

  readonly intents = defer(() => this.adapter?.intents ?? EMPTY);

  background(): Observable<HostOperationOutcome> {
    return this.adapter?.background() ?? defer(() => of(unavailableOutcome()));
  }
}

@Injectable({ providedIn: 'root' })
export class HostFileExportService implements HostFileExportOperation {
  private readonly adapter = inject(HOST_FILE_EXPORT_OPERATION, {
    optional: true,
  });
  private readonly systemUi = inject(HostSystemUiService);

  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.adapter?.support() ?? of(unavailableSupport()));
  }

  save(
    request: Parameters<HostFileExportOperation['save']>[0],
  ): Observable<HostFileExportOutcome> {
    return this.systemUi.track(
      defer(() => this.adapter?.save(request) ?? of(unavailableOutcome())),
    );
  }
}

@Injectable({ providedIn: 'root' })
export class HostNotificationPresentationService {
  private readonly adapter = inject(HOST_NOTIFICATION_PRESENTATION_OPERATION, {
    optional: true,
  });

  support(): Observable<HostCapabilitySupport> {
    return (
      this.adapter?.presentationSupport() ??
      defer(() => of(unavailableSupport()))
    );
  }

  readonly activated = defer(() => this.adapter?.activated ?? EMPTY);

  requestPermission(): Observable<HostOperationOutcome> {
    return (
      this.adapter?.requestPermission() ?? defer(() => of(unavailableOutcome()))
    );
  }

  present(
    request: Parameters<HostNotificationPresentationOperation['present']>[0],
  ): Observable<HostOperationOutcome> {
    return (
      this.adapter?.present(request) ?? defer(() => of(unavailableOutcome()))
    );
  }
}

@Injectable({ providedIn: 'root' })
export class HostLifecycleService implements HostLifecycleOperation {
  private readonly adapter = inject(HOST_LIFECYCLE_OPERATION, {
    optional: true,
  });

  readonly events = defer(() => this.adapter?.events ?? EMPTY);

  releaseMemory(): Observable<HostOperationOutcome> {
    return defer(
      () => this.adapter?.releaseMemory?.() ?? of(unavailableOutcome()),
    );
  }
}

@Injectable({ providedIn: 'root' })
export class HostUpdatesService implements HostUpdatesOperation {
  private readonly adapter = inject(HOST_UPDATES_OPERATION, { optional: true });

  check(): Observable<HostOperationOutcome> {
    return defer(() => this.adapter?.check() ?? of(unavailableOutcome()));
  }
}

@Injectable({ providedIn: 'root' })
export class HostUserPresenceService implements HostUserPresenceOperation {
  private readonly adapter = inject(HOST_USER_PRESENCE_OPERATION, {
    optional: true,
  });
  private readonly systemUi = inject(HostSystemUiService);

  support(): Observable<HostUserPresenceSupport> {
    return defer(() => this.adapter?.support() ?? of(NO_USER_PRESENCE));
  }

  /** The system prompt; counted as Trinity's own system UI while it is open. */
  verify(request: {
    readonly reason: string;
  }): Observable<HostPresenceOutcome> {
    return this.systemUi.track(
      defer(
        () =>
          this.adapter?.verify(request) ??
          of<HostPresenceOutcome>({
            kind: 'unavailable',
            reason: 'not-supported',
          }),
      ),
    );
  }

  setPin(pin: string): Observable<HostOperationOutcome> {
    return defer(() => this.adapter?.setPin(pin) ?? of(unavailableOutcome()));
  }

  verifyPin(pin: string): Observable<HostPinOutcome> {
    return defer(
      () =>
        this.adapter?.verifyPin(pin) ??
        of<HostPinOutcome>({ kind: 'unavailable' }),
    );
  }

  clearPin(): Observable<HostOperationOutcome> {
    return defer(() => this.adapter?.clearPin() ?? of(unavailableOutcome()));
  }
}

@Injectable({ providedIn: 'root' })
export class HostLockIntegrationService implements HostLockIntegrationOperation {
  private readonly adapter = inject(HOST_LOCK_INTEGRATION_OPERATION, {
    optional: true,
  });

  readonly requests: Observable<HostLockRequest> = defer(
    () => this.adapter?.requests ?? EMPTY,
  );

  setState(state: HostLockState): Observable<HostOperationOutcome> {
    return defer(
      () => this.adapter?.setState(state) ?? of(unavailableOutcome()),
    );
  }

  coverPainted(): Observable<HostOperationOutcome> {
    return defer(
      () => this.adapter?.coverPainted() ?? of(unavailableOutcome()),
    );
  }
}

@Injectable({ providedIn: 'root' })
export class HostScreenPrivacyService implements HostScreenPrivacyOperation {
  private readonly adapter = inject(HOST_SCREEN_PRIVACY_OPERATION, {
    optional: true,
  });

  support(): Observable<HostScreenPrivacySupport> {
    return defer(() => this.adapter?.support() ?? of(unavailableSupport()));
  }

  set(enabled: boolean): Observable<HostOperationOutcome> {
    return defer(() => this.adapter?.set(enabled) ?? of(unavailableOutcome()));
  }

  dismissPresented(): Observable<HostOperationOutcome> {
    return defer(
      () => this.adapter?.dismissPresented() ?? of(unavailableOutcome()),
    );
  }
}
