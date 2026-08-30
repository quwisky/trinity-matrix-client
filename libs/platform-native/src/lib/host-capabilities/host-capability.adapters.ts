import {
  Injectable,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  HOST_BADGE_OPERATION,
  HOST_CAPABILITY_NEGOTIATOR,
  HOST_OPERATIONS,
  type HostBadgeOperation,
  type HostCapabilityManifest,
  type HostCapabilityNegotiator,
  type HostCapabilitySupport,
  type HostOperationOutcome,
  type HostUnavailableReason,
  unavailableHostManifest,
} from '@trinity/runtime/host';
import {
  Observable,
  catchError,
  combineLatest,
  defer,
  from,
  map,
  of,
  shareReplay,
  switchMap,
} from 'rxjs';
import { MobileBadgeService } from '../mobile-badge.service';
import { getTrinityDesktopBridge } from '../trinity-desktop-bridge';
import {
  ServiceWorkerHostUpdatesAdapter,
  hostOperationProviders,
} from './host-operation.adapters';
import { CapacitorNotificationPresentationAdapter } from './host-notification-presentation.adapters';

type HostAdapter = HostBadgeOperation & HostCapabilityNegotiator;

function isSupport(value: unknown): value is HostCapabilitySupport {
  if (!value || typeof value !== 'object') return false;
  const support = value as { kind?: unknown; reason?: unknown };
  return (
    support.kind === 'supported' ||
    (support.kind === 'unavailable' &&
      [
        'not-implemented',
        'not-supported',
        'protocol-mismatch',
        'host-rejected',
      ].includes(String(support.reason)))
  );
}

function isOperationSupportMap(
  value: unknown,
): value is HostCapabilityManifest['operations'] {
  if (!value || typeof value !== 'object') return false;
  const operations = value as Record<string, unknown>;
  return HOST_OPERATIONS.every((operation) => isSupport(operations[operation]));
}

function safeSupport(value: HostCapabilitySupport): HostCapabilitySupport {
  return value.kind === 'supported'
    ? { kind: 'supported' }
    : { kind: 'unavailable', reason: value.reason };
}

function normalizeElectronManifest(value: unknown): HostCapabilityManifest {
  if (!value || typeof value !== 'object') {
    return unavailableHostManifest('host-rejected', {
      code: 'electron-malformed-response',
    });
  }
  const result = value as {
    kind?: unknown;
    protocolVersion?: unknown;
    operations?: unknown;
    reason?: unknown;
  };
  if (result.kind === 'rejected') {
    return unavailableHostManifest(
      result.reason === 'protocol-mismatch'
        ? 'protocol-mismatch'
        : 'host-rejected',
      result.reason === 'malformed-request'
        ? { code: 'electron-malformed-negotiation' }
        : undefined,
    );
  }
  if (
    result.kind !== 'accepted' ||
    result.protocolVersion !== 1 ||
    !isOperationSupportMap(result.operations)
  ) {
    return unavailableHostManifest('host-rejected', {
      code: 'electron-malformed-response',
    });
  }
  return {
    protocolVersion: 1,
    operations: {
      'authentication-handoff': safeSupport(
        result.operations['authentication-handoff'],
      ),
      'deep-links': safeSupport(result.operations['deep-links']),
      back: safeSupport(result.operations.back),
      'file-export': safeSupport(result.operations['file-export']),
      'notification-presentation': safeSupport(
        result.operations['notification-presentation'],
      ),
      location: safeSupport(result.operations.location),
      badge: safeSupport(result.operations.badge),
      'secure-store': safeSupport(result.operations['secure-store']),
      lifecycle: safeSupport(result.operations.lifecycle),
      updates: safeSupport(result.operations.updates),
    },
  };
}

function normalizeElectronOutcome(value: unknown): HostOperationOutcome {
  if (!value || typeof value !== 'object') {
    return {
      kind: 'rejected',
      diagnostic: { code: 'electron-malformed-operation-response' },
    };
  }
  const result = value as {
    kind?: unknown;
    reason?: unknown;
  };
  if (result.kind === 'completed') return { kind: 'completed' };
  if (
    result.kind === 'unavailable' &&
    [
      'not-implemented',
      'not-supported',
      'protocol-mismatch',
      'host-rejected',
    ].includes(String(result.reason))
  ) {
    return {
      kind: 'unavailable',
      reason: result.reason as Extract<
        HostOperationOutcome,
        { kind: 'unavailable' }
      >['reason'],
    };
  }
  if (result.kind === 'rejected') {
    return {
      kind: 'rejected',
      diagnostic: { code: 'electron-badge-rejected' },
    };
  }
  return {
    kind: 'rejected',
    diagnostic: { code: 'electron-malformed-operation-response' },
  };
}

function manifest(
  badge: HostCapabilitySupport,
  supported: readonly (keyof HostCapabilityManifest['operations'])[],
  unavailableReason: HostUnavailableReason,
): HostCapabilityManifest {
  const supports = new Set(supported);
  return {
    protocolVersion: 1,
    operations: {
      'authentication-handoff': supports.has('authentication-handoff')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      'deep-links': supports.has('deep-links')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      back: supports.has('back')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      'file-export': supports.has('file-export')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      'notification-presentation': supports.has('notification-presentation')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      location: supports.has('location')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      badge,
      'secure-store': supports.has('secure-store')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      lifecycle: supports.has('lifecycle')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
      updates: supports.has('updates')
        ? { kind: 'supported' }
        : { kind: 'unavailable', reason: unavailableReason },
    },
  };
}

function capacitorSupportedOperations(
  platform: string,
  notificationPresentation: HostCapabilitySupport,
): readonly (keyof HostCapabilityManifest['operations'])[] {
  return [
    'authentication-handoff',
    'deep-links',
    ...(platform === 'android' ? (['back'] as const) : []),
    'file-export',
    'location',
    'secure-store',
    'lifecycle',
    ...(notificationPresentation.kind === 'supported'
      ? (['notification-presentation'] as const)
      : []),
  ];
}

@Injectable({ providedIn: 'root' })
export class WebHostCapabilityAdapter implements HostAdapter {
  private readonly updates = inject(ServiceWorkerHostUpdatesAdapter);

  support(): Observable<HostCapabilitySupport> {
    return defer(() =>
      of(
        typeof navigator !== 'undefined' &&
          typeof navigator.setAppBadge === 'function' &&
          typeof navigator.clearAppBadge === 'function'
          ? ({ kind: 'supported' } as const)
          : ({ kind: 'unavailable', reason: 'not-supported' } as const),
      ),
    );
  }

  set(count: number): Observable<HostOperationOutcome> {
    return this.support().pipe(
      switchMap((support) => {
        if (support.kind === 'unavailable') return of(support);
        const task =
          count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
        return from(task).pipe(
          map(() => ({ kind: 'completed' }) as const),
          catchError(() =>
            of({
              kind: 'rejected',
              diagnostic: { code: 'badge-update-failed' },
            } as const),
          ),
        );
      }),
    );
  }

  manifest(): Observable<HostCapabilityManifest> {
    return combineLatest([this.support(), this.updates.support()]).pipe(
      map(([badge, updates]) =>
        manifest(
          badge,
          [
            'authentication-handoff',
            'file-export',
            'location',
            'lifecycle',
            ...(updates.kind === 'supported' ? (['updates'] as const) : []),
            ...(typeof Notification !== 'undefined'
              ? (['notification-presentation'] as const)
              : []),
          ],
          'not-supported',
        ),
      ),
    );
  }
}

@Injectable({ providedIn: 'root' })
export class CapacitorHostCapabilityAdapter implements HostAdapter {
  private readonly badge = inject(MobileBadgeService);
  private readonly notifications = inject(
    CapacitorNotificationPresentationAdapter,
  );
  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.badge.support());
  }

  set(count: number): Observable<HostOperationOutcome> {
    return defer(() => this.badge.set(count));
  }

  manifest(): Observable<HostCapabilityManifest> {
    return combineLatest([
      this.support(),
      this.notifications.presentationSupport(),
    ]).pipe(
      map(([badge, notificationPresentation]) =>
        manifest(
          badge,
          capacitorSupportedOperations(
            Capacitor.getPlatform(),
            notificationPresentation,
          ),
          'not-supported',
        ),
      ),
    );
  }
}

@Injectable({ providedIn: 'root' })
export class ElectronHostCapabilityAdapter implements HostAdapter {
  private negotiated?: Observable<HostCapabilityManifest>;
  private bridge?: ReturnType<typeof getTrinityDesktopBridge>;
  manifest(): Observable<HostCapabilityManifest> {
    return (this.negotiated ??= defer(() => {
      const bridge = getTrinityDesktopBridge();
      if (!bridge) return of(unavailableHostManifest('not-supported'));
      this.bridge = bridge;
      return from(bridge.negotiate(HOST_OPERATIONS)).pipe(
        map(normalizeElectronManifest),
        catchError(() =>
          of(
            unavailableHostManifest('host-rejected', {
              code: 'electron-negotiation-failed',
            }),
          ),
        ),
      );
    }).pipe(shareReplay({ bufferSize: 1, refCount: false })));
  }

  support(): Observable<HostCapabilitySupport> {
    return this.manifest().pipe(map((value) => value.operations.badge));
  }

  set(count: number): Observable<HostOperationOutcome> {
    return this.support().pipe(
      switchMap((support) => {
        if (support.kind === 'unavailable') return of(support);
        const bridge = this.bridge;
        return bridge
          ? from(bridge.capabilities.badge.set(count)).pipe(
              map(normalizeElectronOutcome),
              catchError(() =>
                of({
                  kind: 'rejected',
                  diagnostic: { code: 'electron-badge-failed' },
                } as const),
              ),
            )
          : of({ kind: 'unavailable', reason: 'not-supported' } as const);
      }),
    );
  }
}

function selectedHostAdapter(): HostAdapter {
  if (getTrinityDesktopBridge()) {
    return inject(ElectronHostCapabilityAdapter);
  }
  return Capacitor.isNativePlatform()
    ? inject(CapacitorHostCapabilityAdapter)
    : inject(WebHostCapabilityAdapter);
}

/** Select operation adapters once at the application composition root. */
export function provideHostCapabilities(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: HOST_BADGE_OPERATION,
      useFactory: selectedHostAdapter,
    },
    {
      provide: HOST_CAPABILITY_NEGOTIATOR,
      useFactory: selectedHostAdapter,
    },
    ...hostOperationProviders(),
  ]);
}
