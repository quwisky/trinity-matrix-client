import { Injectable, inject, signal } from '@angular/core';
import {
  type Observable,
  finalize,
  of,
  switchMap,
  throwError,
  timeout,
} from 'rxjs';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { GeolocationService, type GeoPoint } from '@trinity/platform-native';
import { ManualLocationDialogComponent } from './manual-location-dialog/manual-location-dialog.component';

/**
 * Shares a location to the open room as an `m.location` message.
 *
 * On web/mobile it resolves the device's current position through Capacitor's
 * native/browser adapter (prompting for permission). On the desktop shell it instead
 * opens the manual-location dialog, because Chromium's
 * `navigator.geolocation` can't resolve a position without an embedded Google API key
 * — so the on-device path would just stall. Either way the resolved point flows into
 * {@link TimelineActionsService.sendLocation}; a denied/failed request surfaces a
 * toast, and {@link sharing} tracks the in-flight send so the composer can show a busy
 * state.
 */
@Injectable({ providedIn: 'root' })
export class LocationShareService {
  private readonly geo = inject(GeolocationService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly toast = inject(TrnToastService);
  private readonly dialog = inject(TrnDialogService);

  private readonly sharingSig = signal(false);
  /** True while a resolved location is being sent (drives the composer's busy state). */
  readonly sharing = this.sharingSig.asReadonly();

  /** Resolve a location and send it to the active room. */
  share(): void {
    if (!this.geo.supportsPrecise()) {
      void this.shareViaDialog();
      return;
    }
    // Bound the whole request: the browser's own `timeout` clock only starts once
    // permission is granted, so an unanswered/soft-dismissed prompt never settles —
    // without this the busy state (and the disabled button) would stick on for the
    // session. On timeout we error, which clears busy via `finalize` and toasts.
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
  private async shareViaDialog(): Promise<void> {
    const point = await this.dialog.openAndWait<
      GeoPoint | null,
      ManualLocationDialogComponent
    >(ManualLocationDialogComponent, {});
    if (point) {
      this.send(of(point));
    }
  }

  /** Send the resolved point to the room, tracking busy state and toasting failures. */
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
            { duration: 4000, variant: 'destructive' },
          ),
      });
  }
}
