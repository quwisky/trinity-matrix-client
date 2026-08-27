import {
  dialog,
  ipcMain,
  net,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebFrameMain,
} from 'electron';
import { isAppUrl } from './scheme';
import { getMainWindow } from './window';
import {
  createNativeLocationProvider,
  type NativeLocationProvider,
  type NativeLocationResult,
} from './native-location';

/** IPC channel the preload's `resolveApproxLocation` invokes. */
export const APPROX_LOCATION_CHANNEL = 'trinity:geolocation:approximate';
/** IPC channel the preload's `resolveCurrentLocation` invokes. */
export const CURRENT_LOCATION_CHANNEL = 'trinity:geolocation:current';

// Keyless, HTTPS IP-geolocation endpoint. City-level accuracy is intentional —
// this is the desktop convenience fallback, not precise device positioning.
const IP_GEO_URL = 'https://ipapi.co/json/';
const LOOKUP_TIMEOUT_MS = 8_000;

type ConfirmCurrentLocation = (window: BrowserWindow) => Promise<boolean>;

/** Ask for a fresh, trusted user decision from Electron's main process. */
async function confirmCurrentLocation(window: BrowserWindow): Promise<boolean> {
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Share your location',
      message: 'Use your precise location?',
      detail:
        'Trinity will request one position from the operating system. You can choose a location manually instead.',
      buttons: ['Use precise location', 'Choose manually'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  } catch {
    return false;
  }
}

/**
 * Require the exact live main document that started the request to remain trusted and
 * foregrounded. A navigation replaces `mainFrame`, so its new document cannot inherit
 * an authorization or result belonging to the old one.
 */
function isTrustedCurrentLocationCaller(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  frame: WebFrameMain,
  provider: NativeLocationProvider,
): boolean {
  const contents = window.webContents;
  return (
    getMainWindow() === window &&
    !window.isDestroyed() &&
    !contents.isDestroyed() &&
    event.sender === contents &&
    event.senderFrame === frame &&
    contents.mainFrame === frame &&
    !frame.isDestroyed() &&
    !frame.detached &&
    isAppUrl(frame.url) &&
    isAppUrl(contents.getURL()) &&
    window.isVisible() &&
    (window.isFocused() || provider.syntheticE2E === true)
  );
}

/** Coerce a lat/lng pair to a finite point inside WGS84 bounds, else null. */
function toGeoPoint(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  return { lat: latitude, lng: longitude };
}

/**
 * Wire the approximate-location IPC (renderer → main, request/response).
 *
 * Estimates the device's location from its public IP (city-level) via a keyless
 * HTTPS lookup made from the MAIN process. This exists because Chromium's own
 * `navigator.geolocation` is backed by Google's network provider, which prebuilt
 * Electron can't authenticate without an embedded API key — so it never resolves on
 * a keyboard-and-mouse desktop with no GPS. Running the request in main (not the
 * renderer) means it bypasses the renderer's strict CSP and rides Chromium's
 * proxy-aware network stack.
 *
 * Treats the channel as untrusted: only our own main window's renderer is served,
 * the request is time-boxed, and any failed/malformed lookup resolves to `null` so
 * the renderer falls back to manual entry instead of hanging. Sends only the IP the
 * request originates from — never GPS or Wi-Fi scan data.
 */
export function registerGeolocationIpc(
  provider: NativeLocationProvider = createNativeLocationProvider(),
  confirm: ConfirmCurrentLocation = confirmCurrentLocation,
): void {
  let activeRequest:
    { frame: WebFrameMain; promise: Promise<NativeLocationResult> } | undefined;
  ipcMain.handle(CURRENT_LOCATION_CHANNEL, async (event) => {
    const win = getMainWindow();
    const frame = event.senderFrame;
    if (
      !win ||
      !frame ||
      !isTrustedCurrentLocationCaller(event, win, frame, provider)
    ) {
      return { status: 'unavailable' } satisfies NativeLocationResult;
    }
    if (activeRequest) {
      return activeRequest.frame === frame
        ? activeRequest.promise
        : ({ status: 'unavailable' } satisfies NativeLocationResult);
    }

    const promise = async (): Promise<NativeLocationResult> => {
      if (provider.syntheticE2E !== true && !(await confirm(win))) {
        return { status: 'cancelled' };
      }
      if (!isTrustedCurrentLocationCaller(event, win, frame, provider)) {
        return { status: 'cancelled' };
      }
      try {
        const result = await provider.requestCurrentLocation();
        return isTrustedCurrentLocationCaller(event, win, frame, provider)
          ? result
          : { status: 'cancelled' };
      } catch {
        return { status: 'error' };
      }
    };
    const transaction = promise();
    activeRequest = { frame, promise: transaction };
    void transaction.finally(() => {
      if (activeRequest?.promise === transaction) {
        activeRequest = undefined;
      }
    });
    return transaction;
  });

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
