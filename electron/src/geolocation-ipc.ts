import { ipcMain, net } from 'electron';
import { getMainWindow } from './window';

/** IPC channel the preload's `resolveApproxLocation` invokes. */
export const APPROX_LOCATION_CHANNEL = 'trinity:geolocation:approximate';

// Keyless HTTPS IP-geolocation. City-level accuracy is intentional: a convenience fallback,
// not device positioning.
const IP_GEO_URL = 'https://ipapi.co/json/';
const LOOKUP_TIMEOUT_MS = 8_000;

/**
 * A numeric lat/lng pair as a finite point inside WGS84 bounds, else null. Nothing is
 * coerced: `Number(null)` is 0, which would turn an unknown location into 0,0.
 */
function toGeoPoint(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }
  return { lat, lng };
}

/**
 * Wire the approximate-location IPC: a city-level estimate from the public IP, looked up
 * from the main process. Chromium's own `navigator.geolocation` uses Google's network
 * provider, which prebuilt Electron can't authenticate without an embedded API key, so it
 * never resolves on a desktop with no GPS. Running in main also bypasses the renderer's
 * strict CSP and uses Chromium's proxy-aware network stack.
 *
 * Untrusted channel: only our own main window's renderer is served, the request is
 * time-boxed, and any failed or malformed lookup resolves to `null` so the renderer falls
 * back to manual entry instead of hanging. Sends only the request's own IP, never GPS or
 * Wi-Fi scan data.
 */
export function registerGeolocationIpc(): void {
  ipcMain.handle(APPROX_LOCATION_CHANNEL, async (event) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const response = await net.fetch(IP_GEO_URL, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as {
        latitude?: unknown;
        longitude?: unknown;
      };
      return toGeoPoint(data?.latitude, data?.longitude);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}
