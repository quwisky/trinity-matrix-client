import { Injectable } from '@angular/core';
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

const NATIVE_BADGE_OPERATION_TIMEOUT_MS = 5_000;

function withinTimeout<T>(call: Promise<T>): Promise<T> {
  return firstValueFrom(
    from(call).pipe(timeout({ first: NATIVE_BADGE_OPERATION_TIMEOUT_MS })),
  );
}

/**
 * iOS / Android app-icon badge sink, called by {@link AppBadgeService} only on a native
 * Capacitor platform, via `@capawesome/capacitor-badge`.
 *
 * iOS needs the `badge` notification authorization (requested once, lazily, and cached).
 * Android launcher badges need no permission, but availability depends on the launcher, so
 * display is best-effort. Commands are cold, finite Observables with stable secret-safe
 * diagnostic codes.
 */
@Injectable({ providedIn: 'root' })
export class MobileBadgeService implements HostBadgeOperation {
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
              from(count > 0 ? Badge.set({ count }) : Badge.clear()),
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
    if (
      !Capacitor.isNativePlatform() ||
      !Capacitor.isPluginAvailable('Badge')
    ) {
      return false;
    }
    const { isSupported } = await withinTimeout(Badge.isSupported());
    if (!isSupported) {
      return false;
    }
    const { display: current } = await withinTimeout(Badge.checkPermissions());
    if (current === 'granted') return true;
    if (current === 'denied') return false;
    // iOS prompts for the `badge` authorization once; Android resolves granted without a
    // prompt. The request waits on the person, so it is the one call with no time limit.
    const { display } = await Badge.requestPermissions();
    return display === 'granted';
  }
}
