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
 * Resolves the device's current location through Capacitor: the native provider on
 * iOS/Android (Android WebView's browser API can get permission yet never a fix) and the
 * browser adapter on the web. Cold; a missing API or a denied/failed request errors rather
 * than hanging.
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
            // Prefer GPS: Android's balanced fused provider can wait indefinitely when network
            // positioning is unavailable. Approximate-only permission still downgrades this
            // request safely on Android 12+.
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
   * Whether the desktop shell exposes its IP-based approximate lookup; false on web/mobile
   * and older desktop builds. Gates the opt-in "use my approximate location" affordance.
   */
  supportsApproximate(): boolean {
    return (
      typeof getTrinityDesktopBridge()?.capabilities.location.approximate ===
      'function'
    );
  }

  /**
   * The approximate (city-level) location via the desktop shell's IP lookup. Cold; errors if
   * the bridge is absent or the estimate fails. Exists because on desktop {@link current}
   * can't resolve without a Google API key.
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
