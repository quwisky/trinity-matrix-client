import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Badge } from '@capawesome/capacitor-badge';
import type {
  HostBadgeOperation,
  HostCapabilitySupport,
  HostOperationOutcome,
} from '@trinity/runtime/host';
import {
  Observable,
  TimeoutError,
  catchError,
  defer,
  finalize,
  firstValueFrom,
  from,
  map,
  of,
  shareReplay,
  switchMap,
  tap,
  timeout,
} from 'rxjs';
import { NativePushDeliveryService } from './native-push-delivery.service';

const NATIVE_BADGE_OPERATION_TIMEOUT_MS = 5_000;

/**
 * iOS / Android app-icon (launcher) badge sink, called by {@link AppBadgeService}
 * only when running on a native Capacitor platform.
 *
 * Backed by `@capawesome/capacitor-badge`: on **iOS** the app-icon badge requires the
 * `badge` notification authorization (requested once, lazily, and cached), while on
 * **Android** launcher badges are notification/launcher-driven and need no permission
 * (their availability depends on the launcher, so treat display as best-effort).
 *
 * Kept behind the host-operation seam so the native dependency stays out of product
 * code. Commands are cold, finite Observables and report unavailable/rejected outcomes
 * with stable secret-safe diagnostic codes.
 */
@Injectable({ providedIn: 'root' })
export class MobileBadgeService implements HostBadgeOperation {
  private readonly nativePush = inject(NativePushDeliveryService);
  /** Finite readiness results are memoized; a failed or timed-out attempt is retryable. */
  private ready?: boolean;
  private readiness?: Observable<boolean>;

  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.ensureReady()).pipe(
      map((ready) =>
        ready
          ? ({ kind: 'supported' } as const)
          : ({ kind: 'unavailable', reason: 'not-supported' } as const),
      ),
      catchError((error: unknown) =>
        of({
          kind: 'unavailable',
          reason: 'host-rejected',
          diagnostic: {
            code:
              error instanceof TimeoutError
                ? 'badge-probe-timeout'
                : 'badge-probe-failed',
          },
        } as const),
      ),
    );
  }

  set(count: number): Observable<HostOperationOutcome> {
    return this.support().pipe(
      switchMap((support) =>
        support.kind === 'unavailable'
          ? of(support)
          : defer(() =>
              this.nativePush.platform === 'android'
                ? this.nativePush.setBadge(count)
                : from(count > 0 ? Badge.set({ count }) : Badge.clear()),
            ).pipe(
              map(() => ({ kind: 'completed' }) as const),
              timeout({ first: NATIVE_BADGE_OPERATION_TIMEOUT_MS }),
              catchError((error: unknown) =>
                of({
                  kind: 'rejected',
                  diagnostic: {
                    code:
                      error instanceof TimeoutError
                        ? 'badge-update-timeout'
                        : 'badge-update-failed',
                  },
                } as const),
              ),
            ),
      ),
    );
  }

  private ensureReady(): Observable<boolean> {
    if (this.ready !== undefined) return of(this.ready);
    if (this.readiness) return this.readiness;

    const readiness = defer(() => from(this.probe())).pipe(
      timeout({ first: NATIVE_BADGE_OPERATION_TIMEOUT_MS }),
      tap((ready) => (this.ready = ready)),
      finalize(() => {
        if (this.readiness === readiness) this.readiness = undefined;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.readiness = readiness;
    return readiness;
  }

  private async probe(): Promise<boolean> {
    if (this.nativePush.platform === 'android') {
      return firstValueFrom(this.nativePush.badgeSupport());
    }
    if (
      !Capacitor.isNativePlatform() ||
      !Capacitor.isPluginAvailable('Badge')
    ) {
      return false;
    }
    const { isSupported } = await Badge.isSupported();
    if (!isSupported) {
      return false;
    }
    // iOS: prompts for the `badge` authorization once. Android: resolves granted
    // without a prompt. Request rather than only check so first use can grant it.
    const { display } = await Badge.requestPermissions();
    return display === 'granted';
  }
}
