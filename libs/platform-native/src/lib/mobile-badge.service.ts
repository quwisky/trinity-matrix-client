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

type BadgeState = 'unsupported' | 'prompt' | 'granted' | 'denied';

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
  private state?: BadgeState;
  private readiness?: Observable<BadgeState>;
  private prompting?: Observable<BadgeState>;

  /**
   * Whether badges can work, without asking the person: startup waits on this under a deadline,
   * and the permission prompt waits on them. The prompt itself happens in {@link set}.
   */
  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.ensureReady()).pipe(
      map((state) =>
        state === 'prompt' || state === 'granted'
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
          : defer(() => this.ensureReady()).pipe(
              // Nothing is showing before the first unread count, so there is nothing to clear
              // and no reason to ask yet.
              switchMap((state) =>
                state === 'prompt' && count <= 0
                  ? of(state)
                  : state === 'prompt'
                    ? this.requestPermission()
                    : of(state),
              ),
              switchMap((state) =>
                state === 'granted'
                  ? defer(() =>
                      from(count > 0 ? Badge.set({ count }) : Badge.clear()),
                    ).pipe(
                      map(() => ({ kind: 'completed' }) as const),
                      timeout({ first: NATIVE_BADGE_OPERATION_TIMEOUT_MS }),
                    )
                  : of(
                      state === 'prompt'
                        ? ({ kind: 'completed' } as const)
                        : ({
                            kind: 'unavailable',
                            reason: 'not-supported',
                          } as const),
                    ),
              ),
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

  private ensureReady(): Observable<BadgeState> {
    if (this.state !== undefined) return of(this.state);
    if (this.readiness) return this.readiness;

    const readiness = defer(() => from(this.probe())).pipe(
      tap((state) => (this.state = state)),
      finalize(() => {
        if (this.readiness === readiness) this.readiness = undefined;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.readiness = readiness;
    return readiness;
  }

  /** One system prompt at a time; it waits as long as the person takes, with no time limit. */
  private requestPermission(): Observable<BadgeState> {
    if (this.prompting) return this.prompting;
    const prompting = defer(() => from(Badge.requestPermissions())).pipe(
      map(({ display }): BadgeState =>
        display === 'granted' ? 'granted' : 'denied',
      ),
      tap((state) => (this.state = state)),
      finalize(() => (this.prompting = undefined)),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.prompting = prompting;
    return prompting;
  }

  private async probe(): Promise<BadgeState> {
    if (
      !Capacitor.isNativePlatform() ||
      !Capacitor.isPluginAvailable('Badge')
    ) {
      return 'unsupported';
    }
    const { isSupported } = await withinTimeout(Badge.isSupported());
    if (!isSupported) return 'unsupported';
    const { display } = await withinTimeout(Badge.checkPermissions());
    return display === 'granted'
      ? 'granted'
      : display === 'denied'
        ? 'denied'
        : 'prompt';
  }
}
