import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Geolocation, type PositionOptions } from '@capacitor/geolocation';
import {
  type Observable,
  catchError,
  defer,
  from,
  map,
  throwError,
} from 'rxjs';
import { getTrinityDesktopBridge } from './trinity-desktop-bridge';

/** A geographic point resolved from the device. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

function normalizeLocationError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return new Error(error.message);
  }
  return new Error('Could not get your location.');
}

/**
 * Resolves the device's current location through Capacitor: its native provider on
 * iOS/Android and its browser adapter on the web. The native provider is deliberate:
 * Android WebView's browser API can receive permission yet never receive a
 * fused-provider fix. Exposed as a cold Observable so callers can surface errors; a
 * missing API or a denied/failed request errors rather than hanging.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  /** Whether this host can fulfill the precise-location operation directly. */
  supportsPrecise(): boolean {
    return !getTrinityDesktopBridge();
  }

  /** The device's current position as {@link GeoPoint}. Cold — prompts on subscribe. */
  current(): Observable<GeoPoint> {
    return defer(() => {
      const isNative = Capacitor.isNativePlatform();
      if (
        !isNative &&
        (typeof navigator === 'undefined' || !navigator.geolocation)
      ) {
        throw new Error('Location isn’t available on this device.');
      }
      const options: PositionOptions = isNative
        ? {
            // Prefer GPS when available. Android's balanced fused provider can wait
            // indefinitely when network positioning is unavailable; approximate-only
            // permission still downgrades this request safely on Android 12+.
            enableHighAccuracy: true,
            timeout: 20_000,
            maximumAge: 60_000,
            enableLocationFallback: true,
          }
        : {
            enableHighAccuracy: false,
            timeout: 10_000,
            maximumAge: 60_000,
          };
      return from(Geolocation.getCurrentPosition(options));
    }).pipe(
      map((position) => ({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      })),
      catchError((error: unknown) =>
        throwError(() => normalizeLocationError(error)),
      ),
    );
  }

  /**
   * Whether the desktop shell can estimate an approximate location (its IP-based
   * lookup is exposed). False on web/mobile and on older desktop builds — callers
   * use it to gate the opt-in "use my approximate location" affordance.
   */
  supportsApproximate(): boolean {
    return (
      typeof getTrinityDesktopBridge()?.capabilities.location.approximate ===
      'function'
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
      const resolve =
        getTrinityDesktopBridge()?.capabilities.location.approximate;
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
