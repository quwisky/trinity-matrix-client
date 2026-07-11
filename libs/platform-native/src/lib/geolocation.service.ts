import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** A geographic point resolved from the device. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Resolves the device's current location via the platform `navigator.geolocation`
 * (works on web and inside the Capacitor/Electron WebViews, gated by the OS permission
 * prompt). Exposed as a cold Observable so callers can cancel and surface errors; a
 * missing API or a denied/failed request errors rather than hanging.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  /** The device's current position as {@link GeoPoint}. Cold — prompts on subscribe. */
  current(): Observable<GeoPoint> {
    return new Observable<GeoPoint>((subscriber) => {
      const geo =
        typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
      if (!geo) {
        subscriber.error(new Error('Location isn’t available on this device.'));
        return;
      }
      geo.getCurrentPosition(
        (position) => {
          subscriber.next({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
          subscriber.complete();
        },
        (error) =>
          subscriber.error(
            new Error(error.message || 'Could not get your location.'),
          ),
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
      );
    });
  }
}
