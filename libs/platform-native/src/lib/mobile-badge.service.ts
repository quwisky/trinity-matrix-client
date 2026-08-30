import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Badge } from '@capawesome/capacitor-badge';
import type {
  HostBadgeOperation,
  HostCapabilitySupport,
  HostOperationOutcome,
} from '@trinity/runtime/host';
import { Observable, catchError, defer, from, map, of, switchMap } from 'rxjs';

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
  /**
   * Memoized readiness: resolves `true` once the plugin is present, supported, and
   * the badge permission has been granted. Computed (and the permission requested)
   * exactly once on first use, then reused so we never re-prompt on every update.
   */
  private ready?: Promise<boolean>;

  support(): Observable<HostCapabilitySupport> {
    return defer(() => from(this.ensureReady())).pipe(
      map((ready) =>
        ready
          ? ({ kind: 'supported' } as const)
          : ({ kind: 'unavailable', reason: 'not-supported' } as const),
      ),
      catchError(() =>
        of({
          kind: 'unavailable',
          reason: 'host-rejected',
          diagnostic: { code: 'badge-probe-failed' },
        } as const),
      ),
    );
  }

  set(count: number): Observable<HostOperationOutcome> {
    return this.support().pipe(
      switchMap((support) =>
        support.kind === 'unavailable'
          ? of(support)
          : from(count > 0 ? Badge.set({ count }) : Badge.clear()).pipe(
              map(() => ({ kind: 'completed' }) as const),
              catchError(() =>
                of({
                  kind: 'rejected',
                  diagnostic: { code: 'badge-update-failed' },
                } as const),
              ),
            ),
      ),
    );
  }

  private ensureReady(): Promise<boolean> {
    return (this.ready ??= this.probe().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    }));
  }

  private async probe(): Promise<boolean> {
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
