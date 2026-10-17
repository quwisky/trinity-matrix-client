import { Injectable, inject, signal } from '@angular/core';
import {
  type Observable,
  filter,
  finalize,
  switchMap,
  throwError,
  timeout,
} from 'rxjs';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { GeolocationService, type GeoPoint } from '@trinity/platform-native';
import { ManualLocationDialogComponent } from './manual-location-dialog/manual-location-dialog.component';

/**
 * Shares a location to the open room as an `m.location` message. On web/mobile it resolves
 * the device position through Capacitor's adapter (prompting for permission). On the desktop
 * shell it opens the manual-location dialog instead: Chromium's `navigator.geolocation`
 * can't resolve a position without an embedded Google API key and would stall. The resolved
 * point flows into {@link TimelineActionsService.sendLocation}; {@link sharing} tracks the
 * in-flight send.
 */
@Injectable({ providedIn: 'root' })
export class LocationShareService {
  private readonly geo = inject(GeolocationService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnSurfaceService);

  private readonly sharingSig = signal(false);
  readonly sharing = this.sharingSig.asReadonly();

  share(): void {
    if (!this.geo.supportsPrecise()) {
      this.shareViaDialog();
      return;
    }
    // Bound the whole request: the browser's own `timeout` only starts once permission is
    // granted, so an unanswered or soft-dismissed prompt never settles and the busy state
    // would stick for the session. On timeout we error, which clears busy via `finalize`
    // and toasts.
    this.send(
      this.geo.current().pipe(
        timeout({
          each: 30_000,
          with: () =>
            throwError(
              () => new Error('Location request timed out. Try again.'),
            ),
        }),
      ),
    );
  }

  /** Desktop: pick a location by hand (Chromium can't resolve one), then send it. */
  private shareViaDialog(): void {
    this.send(
      this.dialog
        .openAndWait$<GeoPoint, ManualLocationDialogComponent>(
          ManualLocationDialogComponent,
        )
        .pipe(filter((point): point is GeoPoint => point !== null)),
    );
  }

  private send(source: Observable<GeoPoint>): void {
    this.sharingSig.set(true);
    source
      .pipe(
        switchMap(({ lat, lng }) =>
          this.timelineActions.sendLocation(lat, lng),
        ),
        finalize(() => this.sharingSig.set(false)),
      )
      .subscribe({
        error: (err: unknown) =>
          this.toast.show(
            err instanceof Error
              ? err.message
              : 'Could not share your location.',
            { duration: 4000, variant: 'danger' },
          ),
      });
  }
}
