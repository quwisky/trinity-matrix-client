import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { GeolocationService } from './geolocation.service';

interface Bridge {
  resolveApproxLocation?: () => Promise<{ lat: number; lng: number } | null>;
}

function setBridge(bridge: Bridge | undefined): void {
  (globalThis as { trinityDesktop?: Bridge }).trinityDesktop = bridge;
}

/** Install a `navigator.geolocation` stub (jsdom leaves it undefined). */
function setGeolocation(geolocation: unknown): void {
  Object.defineProperty(navigator, 'geolocation', {
    value: geolocation,
    configurable: true,
  });
}

function makeService(): GeolocationService {
  TestBed.configureTestingModule({ providers: [GeolocationService] });
  return TestBed.inject(GeolocationService);
}

describe('GeolocationService', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: Bridge }).trinityDesktop;
    setGeolocation(undefined);
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  describe('current', () => {
    it('emits the coordinates the device resolves', async () => {
      setGeolocation({
        getCurrentPosition: (success: PositionCallback) =>
          success({
            coords: { latitude: 10, longitude: 20 },
          } as GeolocationPosition),
      });

      await expect(firstValueFrom(makeService().current())).resolves.toEqual({
        lat: 10,
        lng: 20,
      });
    });

    it('errors when the request fails', async () => {
      setGeolocation({
        getCurrentPosition: (
          _success: PositionCallback,
          error: PositionErrorCallback,
        ) => error({ message: 'Timeout expired' } as GeolocationPositionError),
      });

      await expect(firstValueFrom(makeService().current())).rejects.toThrow(
        'Timeout expired',
      );
    });

    it('errors when the platform has no geolocation API', async () => {
      setGeolocation(undefined);

      await expect(firstValueFrom(makeService().current())).rejects.toThrow(
        /available/i,
      );
    });
  });

  describe('supportsApproximate', () => {
    it('is true when the desktop bridge exposes the IP lookup', () => {
      setBridge({ resolveApproxLocation: vi.fn() });
      expect(makeService().supportsApproximate()).toBe(true);
    });

    it('is false with no bridge or no resolver', () => {
      const service = makeService();

      setBridge(undefined);
      expect(service.supportsApproximate()).toBe(false);

      setBridge({});
      expect(service.supportsApproximate()).toBe(false);
    });
  });

  describe('approximateFromDesktop', () => {
    it('resolves the point the bridge estimates', async () => {
      setBridge({
        resolveApproxLocation: vi
          .fn()
          .mockResolvedValue({ lat: 1.5, lng: 2.5 }),
      });

      await expect(
        firstValueFrom(makeService().approximateFromDesktop()),
      ).resolves.toEqual({ lat: 1.5, lng: 2.5 });
    });

    it('errors when the bridge is absent (non-desktop)', async () => {
      setBridge(undefined);

      await expect(
        firstValueFrom(makeService().approximateFromDesktop()),
      ).rejects.toThrow(/available/i);
    });

    it('errors when the estimate comes back null', async () => {
      setBridge({
        resolveApproxLocation: vi.fn().mockResolvedValue(null),
      });

      await expect(
        firstValueFrom(makeService().approximateFromDesktop()),
      ).rejects.toThrow(/estimate/i);
    });

    it('propagates a rejected lookup', async () => {
      setBridge({
        resolveApproxLocation: vi.fn().mockRejectedValue(new Error('net')),
      });

      await expect(
        firstValueFrom(makeService().approximateFromDesktop()),
      ).rejects.toThrow('net');
    });
  });
});
