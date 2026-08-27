import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type NativeLocationResult =
  | { status: 'ok'; lat: number; lng: number; accuracy: number }
  | { status: 'denied' | 'unavailable' | 'timeout' | 'cancelled' | 'error' };

export interface NativeLocationProvider {
  /** Test-only escape hatch for headless Xvfb, which has no window manager/focus. */
  readonly allowUnfocused?: boolean;
  requestCurrentLocation(): Promise<NativeLocationResult>;
  dispose?(): void;
}

export interface NativeLocationAddon {
  requestCurrentPosition(timeoutMs: number): Promise<unknown>;
  cancelCurrentRequest(): void;
}

const REQUEST_TIMEOUT_MS = 20_000;
const loadNativeModule = createRequire(__filename);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate the untrusted native boundary before a coordinate reaches the renderer. */
export function normalizeNativeLocationResult(
  value: unknown,
): NativeLocationResult {
  if (!value || typeof value !== 'object' || !('status' in value)) {
    return { status: 'error' };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['status'] === 'ok') {
    const lat = candidate['lat'];
    const lng = candidate['lng'];
    const accuracy = candidate['accuracy'];
    if (
      finite(lat) &&
      finite(lng) &&
      finite(accuracy) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180 &&
      accuracy >= 0
    ) {
      return { status: 'ok', lat, lng, accuracy };
    }
    return { status: 'error' };
  }
  if (
    candidate['status'] === 'denied' ||
    candidate['status'] === 'unavailable' ||
    candidate['status'] === 'timeout' ||
    candidate['status'] === 'cancelled' ||
    candidate['status'] === 'error'
  ) {
    return { status: candidate['status'] };
  }
  return { status: 'error' };
}

function testProvider(): NativeLocationProvider | undefined {
  if (app.isPackaged || !process.env['TRINITY_E2E_LOCATION']) return undefined;
  const [lat, lng, accuracy] = process.env['TRINITY_E2E_LOCATION']
    .split(',')
    .map(Number);
  const result = normalizeNativeLocationResult({
    status: 'ok',
    lat,
    lng,
    accuracy,
  });
  return {
    allowUnfocused: true,
    requestCurrentLocation: () => Promise.resolve(result),
  };
}

function addonPath(): string | undefined {
  const resourcesPath = process.resourcesPath;
  const candidates = app.isPackaged
    ? typeof resourcesPath === 'string'
      ? [path.join(resourcesPath, 'native-location', 'native_location.node')]
      : []
    : [
        path.join(
          app.getAppPath(),
          'native-location',
          'build',
          'Release',
          'native_location.node',
        ),
      ];
  return candidates.find(existsSync);
}

function loadAddon(): NativeLocationAddon | undefined {
  const file = addonPath();
  if (!file) return undefined;
  try {
    return loadNativeModule(file) as NativeLocationAddon;
  } catch {
    return undefined;
  }
}

/** Build the one-shot provider used by the Electron main process. */
export function createNativeLocationProvider(
  addonOverride?: NativeLocationAddon,
): NativeLocationProvider {
  const injected = addonOverride ? undefined : testProvider();
  if (injected) return injected;

  let addon = addonOverride;
  let nativeInFlight: Promise<unknown> | undefined;
  const dispose = (): void => {
    try {
      addon?.cancelCurrentRequest();
    } catch {
      // Native teardown must never prevent Electron from quitting.
    }
  };
  app.once?.('before-quit', dispose);
  return {
    dispose,
    async requestCurrentLocation(): Promise<NativeLocationResult> {
      addon ??= loadAddon();
      if (!addon) return { status: 'unavailable' };
      if (nativeInFlight) return { status: 'unavailable' };
      const activeAddon = addon;
      nativeInFlight = Promise.resolve(
        activeAddon.requestCurrentPosition(REQUEST_TIMEOUT_MS),
      );
      const nativeRequest = nativeInFlight;
      void nativeRequest.then(
        () => {
          if (nativeInFlight === nativeRequest) nativeInFlight = undefined;
        },
        () => {
          if (nativeInFlight === nativeRequest) nativeInFlight = undefined;
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return normalizeNativeLocationResult(
          await Promise.race([
            nativeRequest,
            new Promise<NativeLocationResult>((resolve) => {
              timer = setTimeout(() => {
                try {
                  activeAddon.cancelCurrentRequest();
                } catch {
                  // The deadline still settles even if native cancellation fails.
                } finally {
                  resolve({ status: 'timeout' });
                }
              }, REQUEST_TIMEOUT_MS);
            }),
          ]),
        );
      } catch {
        return { status: 'error' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
