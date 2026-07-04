import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Badge } from '@capawesome/capacitor-badge';
import { MobileBadgeService } from './mobile-badge.service';

// Mock the native plugin: every method is a spy the tests drive per case.
vi.mock('@capawesome/capacitor-badge', () => ({
  Badge: {
    isSupported: vi.fn(),
    requestPermissions: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

const badge = vi.mocked(Badge);

/** Let the fire-and-forget `set(...)` chain (probe → set/clear) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeService(): MobileBadgeService {
  TestBed.configureTestingModule({ providers: [MobileBadgeService] });
  return TestBed.inject(MobileBadgeService);
}

describe('MobileBadgeService', () => {
  beforeEach(() => {
    // Default happy path: native, plugin present, supported, permission granted.
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
    badge.isSupported.mockResolvedValue({ isSupported: true });
    badge.requestPermissions.mockResolvedValue({ display: 'granted' });
    badge.set.mockResolvedValue();
    badge.clear.mockResolvedValue();
  });

  afterEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('sets the badge to the count for a positive value', async () => {
    makeService().set(5);
    await flush();

    expect(badge.set).toHaveBeenCalledWith({ count: 5 });
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('clears the badge for a count of 0', async () => {
    makeService().set(0);
    await flush();

    expect(badge.clear).toHaveBeenCalledTimes(1);
    expect(badge.set).not.toHaveBeenCalled();
  });

  it('requests the badge permission once, not on every update', async () => {
    const service = makeService();
    service.set(1);
    await flush();
    service.set(2);
    await flush();
    service.set(0);
    await flush();

    expect(badge.requestPermissions).toHaveBeenCalledTimes(1);
    expect(badge.set).toHaveBeenNthCalledWith(1, { count: 1 });
    expect(badge.set).toHaveBeenNthCalledWith(2, { count: 2 });
    expect(badge.clear).toHaveBeenCalledTimes(1);
  });

  it('does not badge when the permission is denied', async () => {
    badge.requestPermissions.mockResolvedValue({ display: 'denied' });

    makeService().set(3);
    await flush();

    expect(badge.set).not.toHaveBeenCalled();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('does not badge when the plugin reports it is unsupported', async () => {
    badge.isSupported.mockResolvedValue({ isSupported: false });

    makeService().set(3);
    await flush();

    expect(badge.requestPermissions).not.toHaveBeenCalled();
    expect(badge.set).not.toHaveBeenCalled();
  });

  it('swallows a rejected plugin call without throwing', async () => {
    badge.set.mockRejectedValue(new Error('boom'));

    const service = makeService();
    expect(() => service.set(4)).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });

  it('is a no-op off a native platform', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);

    makeService().set(7);
    await flush();

    expect(badge.requestPermissions).not.toHaveBeenCalled();
    expect(badge.set).not.toHaveBeenCalled();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('is a no-op when the Badge plugin is unavailable', async () => {
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(false);

    makeService().set(7);
    await flush();

    expect(badge.set).not.toHaveBeenCalled();
  });
});
