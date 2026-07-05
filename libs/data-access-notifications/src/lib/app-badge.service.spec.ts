import { ApplicationRef, WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { AppBadgeService } from './app-badge.service';
import { MobileBadgeService } from '@trinity/platform-native';
import { RoomsService } from '@trinity/data-access-rooms';

type BadgingNavigator = Navigator & {
  setAppBadge?: unknown;
  clearAppBadge?: unknown;
};

/**
 * Instantiate AppBadgeService against a mocked RoomsService whose `totalUnread` is a
 * writable signal the test drives; `flush` runs a change-detection tick so the
 * effect fires. MobileBadgeService is an ng-mocks mock, so `mobile.set` is a vitest
 * spy (autoSpy) the tests can assert against.
 */
function setup(initial: number): {
  total: WritableSignal<number>;
  mobile: MobileBadgeService;
  flush: () => void;
} {
  const total = signal(initial);
  TestBed.configureTestingModule({
    providers: [
      AppBadgeService,
      MockProvider(RoomsService, { totalUnread: total }),
      MockProvider(MobileBadgeService),
    ],
  });
  TestBed.inject(AppBadgeService); // instantiate → registers the effect
  const mobile = TestBed.inject(MobileBadgeService);
  const appRef = TestBed.inject(ApplicationRef);
  return { total, mobile, flush: () => appRef.tick() };
}

describe('AppBadgeService', () => {
  beforeEach(() => {
    // Default environment: not native, no Badging API. Each test opts into a sink.
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
  });

  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    delete (navigator as BadgingNavigator).setAppBadge;
    delete (navigator as BadgingNavigator).clearAppBadge;
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('pushes the total to the Electron desktop bridge, on init and on change', () => {
    const setBadgeCount = vi.fn();
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      setBadgeCount,
    };

    const { total, flush } = setup(3);
    flush();
    expect(setBadgeCount).toHaveBeenLastCalledWith(3);

    total.set(7);
    flush();
    expect(setBadgeCount).toHaveBeenLastCalledWith(7);
  });

  it('uses the native mobile badge on a Capacitor platform (0 clears)', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    const { total, mobile, flush } = setup(2);
    flush();
    expect(mobile.set).toHaveBeenLastCalledWith(2);

    total.set(0);
    flush();
    expect(mobile.set).toHaveBeenLastCalledWith(0);
  });

  it('uses the Web Badging API on web/PWA (set for >0, clear for 0)', () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    (navigator as BadgingNavigator).setAppBadge = setAppBadge;
    (navigator as BadgingNavigator).clearAppBadge = clearAppBadge;

    const { total, flush } = setup(4);
    flush();
    expect(setAppBadge).toHaveBeenLastCalledWith(4);

    total.set(0);
    flush();
    expect(clearAppBadge).toHaveBeenCalled();
  });

  it('clamps an absurd total before handing off to a sink', () => {
    const setBadgeCount = vi.fn();
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      setBadgeCount,
    };
    const { flush } = setup(50000);
    flush();
    expect(setBadgeCount).toHaveBeenLastCalledWith(9999);
  });

  it('is a harmless no-op when no sink is available', () => {
    const { total, flush } = setup(2);
    expect(() => {
      flush();
      total.set(5);
      flush();
    }).not.toThrow();
  });

  it('prefers the Electron bridge over native and the Web Badging API when all are present', () => {
    const setBadgeCount = vi.fn();
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      setBadgeCount,
    };
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const setAppBadge = vi.fn(() => Promise.resolve());
    (navigator as BadgingNavigator).setAppBadge = setAppBadge;

    const { mobile, flush } = setup(5);
    flush();

    expect(setBadgeCount).toHaveBeenLastCalledWith(5);
    expect(mobile.set).not.toHaveBeenCalled(); // native mobile badge not touched
    expect(setAppBadge).not.toHaveBeenCalled(); // Web Badging API not touched
  });
});
