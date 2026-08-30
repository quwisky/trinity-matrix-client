import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { GeolocationService } from './geolocation.service';
import { desktopBridgeFixture } from '@trinity/testing';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));
vi.mock('@capacitor/geolocation', () => ({
  Geolocation: { getCurrentPosition: vi.fn() },
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const capacitorGeolocation = vi.mocked(Geolocation);

type Approximate = () => Promise<{ lat: number; lng: number } | null>;

function setBridge(approximate: Approximate | undefined): void {
  (globalThis as { trinityDesktop?: unknown }).trinityDesktop = approximate
    ? desktopBridgeFixture({ capabilities: { location: { approximate } } })
    : undefined;
}

/** Mark the browser geolocation API available or unavailable in jsdom. */
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
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    setGeolocation(undefined);
    vi.restoreAllMocks();
    isNative.mockReset().mockReturnValue(false);
    capacitorGeolocation.getCurrentPosition.mockReset();
    TestBed.resetTestingModule();
  });

  describe('current', () => {
    it('uses the native provider on iOS and Android', async () => {
      isNative.mockReturnValue(true);
      capacitorGeolocation.getCurrentPosition.mockResolvedValue({
        coords: { latitude: 10, longitude: 20 },
      } as Awaited<ReturnType<typeof Geolocation.getCurrentPosition>>);

      await expect(firstValueFrom(makeService().current())).resolves.toEqual({
        lat: 10,
        lng: 20,
      });
      expect(capacitorGeolocation.getCurrentPosition).toHaveBeenCalledWith({
        enableHighAccuracy: true,
        timeout: 20_000,
        maximumAge: 60_000,
        enableLocationFallback: true,
      });
    });

    it('propagates native permission and provider failures', async () => {
      isNative.mockReturnValue(true);
      capacitorGeolocation.getCurrentPosition.mockRejectedValue(
        new Error('Location permission request was denied.'),
      );

      await expect(firstValueFrom(makeService().current())).rejects.toThrow(
        'Location permission request was denied.',
      );
    });

    it('uses the Capacitor web adapter in browsers', async () => {
      setGeolocation({ getCurrentPosition: vi.fn() });
      capacitorGeolocation.getCurrentPosition.mockResolvedValue({
        coords: { latitude: 10, longitude: 20 },
      } as Awaited<ReturnType<typeof Geolocation.getCurrentPosition>>);

      await expect(firstValueFrom(makeService().current())).resolves.toEqual({
        lat: 10,
        lng: 20,
      });
      expect(capacitorGeolocation.getCurrentPosition).toHaveBeenCalledWith({
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 60_000,
      });
    });

    it('normalizes browser failures that are not Error instances', async () => {
      setGeolocation({ getCurrentPosition: vi.fn() });
      capacitorGeolocation.getCurrentPosition.mockRejectedValue({
        message: 'Timeout expired',
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
      expect(capacitorGeolocation.getCurrentPosition).not.toHaveBeenCalled();
    });
  });

  describe('supportsApproximate', () => {
    it('is true when the desktop bridge exposes the IP lookup', () => {
      setBridge(vi.fn());
      expect(makeService().supportsApproximate()).toBe(true);
    });

    it('is false with no bridge or no resolver', () => {
      const service = makeService();

      setBridge(undefined);
      expect(service.supportsApproximate()).toBe(false);

      const fixture = desktopBridgeFixture();
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
        ...fixture,
        capabilities: { ...fixture.capabilities, location: {} },
      };
      expect(service.supportsApproximate()).toBe(false);
    });
  });

  describe('approximateFromDesktop', () => {
    it('resolves the point the bridge estimates', async () => {
      setBridge(vi.fn().mockResolvedValue({ lat: 1.5, lng: 2.5 }));

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
      setBridge(vi.fn().mockResolvedValue(null));

      await expect(
        firstValueFrom(makeService().approximateFromDesktop()),
      ).rejects.toThrow(/estimate/i);
    });

    it('propagates a rejected lookup', async () => {
      setBridge(vi.fn().mockRejectedValue(new Error('net')));

      await expect(
        firstValueFrom(makeService().approximateFromDesktop()),
      ).rejects.toThrow('net');
    });
  });
});
