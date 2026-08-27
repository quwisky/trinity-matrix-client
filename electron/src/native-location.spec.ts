import { afterEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: vi.fn(() => '/missing/trinity'),
}));
vi.mock('electron', () => ({ app }));

import {
  createNativeLocationProvider,
  normalizeNativeLocationResult,
  type NativeLocationAddon,
} from './native-location';

describe('native location boundary', () => {
  afterEach(() => {
    delete process.env['TRINITY_E2E_LOCATION'];
    app.isPackaged = false;
  });

  it('accepts only finite WGS84 points with a nonnegative accuracy', () => {
    expect(
      normalizeNativeLocationResult({
        status: 'ok',
        lat: 47.5,
        lng: 19.04,
        accuracy: 25,
      }),
    ).toEqual({ status: 'ok', lat: 47.5, lng: 19.04, accuracy: 25 });
    expect(
      normalizeNativeLocationResult({
        status: 'ok',
        lat: 91,
        lng: 19,
        accuracy: 1,
      }),
    ).toEqual({ status: 'error' });
    expect(
      normalizeNativeLocationResult({
        status: 'ok',
        lat: 1,
        lng: 2,
        accuracy: -1,
      }),
    ).toEqual({ status: 'error' });
  });

  it('passes through only known failure statuses', () => {
    expect(normalizeNativeLocationResult({ status: 'denied' })).toEqual({
      status: 'denied',
    });
    expect(normalizeNativeLocationResult({ status: 'invented' })).toEqual({
      status: 'error',
    });
  });

  it('allows a fixed provider only in an unpackaged test process', async () => {
    process.env['TRINITY_E2E_LOCATION'] = '47.5,19.04,10';
    await expect(
      createNativeLocationProvider().requestCurrentLocation(),
    ).resolves.toEqual({
      status: 'ok',
      lat: 47.5,
      lng: 19.04,
      accuracy: 10,
    });

    app.isPackaged = true;
    await expect(
      createNativeLocationProvider().requestCurrentLocation(),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('bounds the whole native request and cancels work at the deadline', async () => {
    vi.useFakeTimers();
    const addon: NativeLocationAddon = {
      requestCurrentPosition: vi.fn(() => new Promise(() => undefined)),
      cancelCurrentRequest: vi.fn(),
    };
    const result = createNativeLocationProvider(addon).requestCurrentLocation();

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toEqual({ status: 'timeout' });
    expect(addon.cancelCurrentRequest).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('cancels an active native request during shutdown disposal', () => {
    const addon: NativeLocationAddon = {
      requestCurrentPosition: vi.fn(),
      cancelCurrentRequest: vi.fn(),
    };
    createNativeLocationProvider(addon).dispose?.();
    expect(addon.cancelCurrentRequest).toHaveBeenCalledOnce();
  });

  it('still settles the deadline when native cancellation throws', async () => {
    vi.useFakeTimers();
    const addon: NativeLocationAddon = {
      requestCurrentPosition: vi.fn(() => new Promise(() => undefined)),
      cancelCurrentRequest: vi.fn(() => {
        throw new Error('native cancellation failed');
      }),
    };
    const result = createNativeLocationProvider(addon).requestCurrentLocation();

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toEqual({ status: 'timeout' });
    expect(() => createNativeLocationProvider(addon).dispose?.()).not.toThrow();
    vi.useRealTimers();
  });
});
