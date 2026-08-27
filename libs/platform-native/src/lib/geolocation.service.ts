import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { getTrinityDesktopBridge } from './trinity-desktop-bridge';

/** A geographic point resolved from the device. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Resolves the device's current location via Capacitor's native provider on iOS/Android
 * and `navigator.geolocation` on the web. The native provider is deliberate: Android
 * WebView's browser API can receive permission yet never receive a fused-provider fix.
 * Exposed as a cold Observable so callers can surface errors; a missing API or a
 * denied/failed request errors rather than hanging.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  /** The device's current position as {@link GeoPoint}. Cold — prompts on subscribe. */
  current(): Observable<GeoPoint> {
    if (Capacitor.isNativePlatform()) {
      return defer(() =>
        Geolocation.getCurrentPosition({
          // Prefer GPS when available. Android's balanced fused provider can wait
          // indefinitely when network positioning is unavailable; approximate-only
          // permission still downgrades this request safely on Android 12+.
          enableHighAccuracy: true,
          timeout: 20_000,
          maximumAge: 60_000,
          enableLocationFallback: true,
        }),
      ).pipe(
        map((position) => ({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })),
      );
    }

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

  /**
   * Whether the desktop shell can estimate an approximate location (its IP-based
   * lookup is exposed). False on web/mobile and on older desktop builds — callers
   * use it to gate the opt-in "use my approximate location" affordance.
   */
  supportsApproximate(): boolean {
    return (
      typeof getTrinityDesktopBridge()?.resolveApproxLocation === 'function'
    );
  }

  /**
   * The device's APPROXIMATE location via the desktop shell's IP lookup (city-level).
   * Cold — resolves through the main process on subscribe; errors if the bridge is
   * absent (non-desktop) or the estimate fails. Backs the manual dialog's opt-in
   * button on desktop, where {@link current} can't resolve without a Google API key.
   */
  approximateFromDesktop(): Observable<GeoPoint> {
    return defer(() => {
      const resolve = getTrinityDesktopBridge()?.resolveApproxLocation;
      if (!resolve) {
        return throwError(
          () => new Error('Approximate location isn’t available here.'),
        );
      }
      return from(resolve()).pipe(
        map((point) => {
          if (!point) {
            throw new Error('Couldn’t estimate your location.');
          }
          return point;
        }),
      );
    });
  }
}
