import { Injectable, InjectionToken, inject } from '@angular/core';
import { EMPTY, Observable, defer, of } from 'rxjs';
import {
  type HostAuthenticationHandoffOperation,
  type HostBackOperation,
  type HostCapabilitySupport,
  type HostDeepLinksOperation,
  type HostFileExportOperation,
  type HostLifecycleOperation,
  type HostNotificationPresentationOperation,
  type HostOperationOutcome,
  type HostUpdatesOperation,
} from './host-capability.models';

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

const unavailableSupport = (): Extract<
  HostCapabilitySupport,
  { kind: 'unavailable' }
> => ({
  kind: 'unavailable',
  reason: 'not-supported',
});
const unavailableOutcome = (): HostOperationOutcome => unavailableSupport();

@Injectable({ providedIn: 'root' })
export class HostAuthenticationHandoffService implements HostAuthenticationHandoffOperation {
  private readonly adapter = inject(HOST_AUTHENTICATION_HANDOFF_OPERATION, {
    optional: true,
  });

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

  open(request: { readonly url: string }): Observable<HostOperationOutcome> {
    return this.adapter?.open(request) ?? defer(() => of(unavailableOutcome()));
  }
}

@Injectable({ providedIn: 'root' })
export class HostDeepLinksService implements HostDeepLinksOperation {
  private readonly adapter = inject(HOST_DEEP_LINKS_OPERATION, {
    optional: true,
  });

  support(): Observable<HostCapabilitySupport> {
    return (
      this.adapter?.deepLinkSupport() ?? defer(() => of(unavailableSupport()))
    );
  }

  deepLinkSupport(): Observable<HostCapabilitySupport> {
    return this.support();
  }

  readonly received = defer(() => this.adapter?.received ?? EMPTY);

  closeAuthentication(): Observable<HostOperationOutcome> {
    return (
      this.adapter?.closeAuthentication() ??
      defer(() => of(unavailableOutcome()))
    );
  }
}

@Injectable({ providedIn: 'root' })
export class HostBackService implements HostBackOperation {
  private readonly adapter = inject(HOST_BACK_OPERATION, { optional: true });

  support(): Observable<HostCapabilitySupport> {
    return this.adapter?.backSupport() ?? defer(() => of(unavailableSupport()));
  }

  backSupport(): Observable<HostCapabilitySupport> {
    return this.support();
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

  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.adapter?.support() ?? of(unavailableSupport()));
  }

  save(
    request: Parameters<HostFileExportOperation['save']>[0],
  ): Observable<HostOperationOutcome> {
    return defer(() => this.adapter?.save(request) ?? of(unavailableOutcome()));
  }
}

@Injectable({ providedIn: 'root' })
export class HostNotificationPresentationService implements HostNotificationPresentationOperation {
  private readonly adapter = inject(HOST_NOTIFICATION_PRESENTATION_OPERATION, {
    optional: true,
  });

  support(): Observable<HostCapabilitySupport> {
    return (
      this.adapter?.presentationSupport() ??
      defer(() => of(unavailableSupport()))
    );
  }

  presentationSupport(): Observable<HostCapabilitySupport> {
    return this.support();
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
}

@Injectable({ providedIn: 'root' })
export class HostUpdatesService implements HostUpdatesOperation {
  private readonly adapter = inject(HOST_UPDATES_OPERATION, { optional: true });

  check(): Observable<HostOperationOutcome> {
    return defer(() => this.adapter?.check() ?? of(unavailableOutcome()));
  }
}
