import { Injectable, inject } from '@angular/core';
import { switchMap } from 'rxjs';
import { TrnToastService } from '@trinity/helm/overlay';
import { TimelineService } from '@trinity/data-access-timeline';
import { GeolocationService } from '@trinity/platform-native';

/**
 * Shares the device's current location to the open room as an `m.location` message.
 * Prompts for the OS location permission (via {@link GeolocationService}), then sends;
 * a denied/failed request surfaces a toast rather than a silent no-op. Mirrors the poll
 * composer button, which likewise delegates to a service that acts on the active room.
 */
@Injectable({ providedIn: 'root' })
export class LocationShareService {
  private readonly geo = inject(GeolocationService);
  private readonly timeline = inject(TimelineService);
  private readonly toast = inject(TrnToastService);

  /** Resolve the current location and send it to the active room. */
  share(): void {
    this.geo
      .current()
      .pipe(switchMap(({ lat, lng }) => this.timeline.sendLocation(lat, lng)))
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
