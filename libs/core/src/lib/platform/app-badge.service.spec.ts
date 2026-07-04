import { ApplicationRef, WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { AppBadgeService } from './app-badge.service';
import { MobileBadgeService } from './mobile-badge.service';
import { RoomsService } from '../matrix/rooms.service';

type BadgingNavigator = Navigator & {
  setAppBadge?: unknown;
  clearAppBadge?: unknown;
};

/**
 * Instantiate AppBadgeService against a mock RoomsService whose `totalUnread` is a
 * writable signal the test drives; `flush` runs a change-detection tick so the
 * effect fires. `mobile.set` is a spy unless overridden.
 */
function setup(
  initial: number,
  mobile: Partial<MobileBadgeService> = {},
): { total: WritableSignal<number>; flush: () => void } {
  const total = signal(initial);
  const rooms = { totalUnread: total } as unknown as RoomsService;
  TestBed.configureTestingModule({
    providers: [
      AppBadgeService,
      { provide: RoomsService, useValue: rooms },
      { provide: MobileBadgeService, useValue: { set: vi.fn(), ...mobile } },
    ],
  });
  TestBed.inject(AppBadgeService); // instantiate → registers the effect
  const appRef = TestBed.inject(ApplicationRef);
  return { total, flush: () => appRef.tick() };
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
    const set = vi.fn();

    const { total, flush } = setup(2, { set });
    flush();
    expect(set).toHaveBeenLastCalledWith(2);

    total.set(0);
    flush();
    expect(set).toHaveBeenLastCalledWith(0);
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
    const set = vi.fn();
    const setAppBadge = vi.fn(() => Promise.resolve());
    (navigator as BadgingNavigator).setAppBadge = setAppBadge;

    const { flush } = setup(5, { set });
    flush();

    expect(setBadgeCount).toHaveBeenLastCalledWith(5);
    expect(set).not.toHaveBeenCalled(); // native mobile badge not touched
    expect(setAppBadge).not.toHaveBeenCalled(); // Web Badging API not touched
  });
});
