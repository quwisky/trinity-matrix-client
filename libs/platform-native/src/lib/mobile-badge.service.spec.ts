import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Badge } from '@capawesome/capacitor-badge';
import { firstValueFrom } from 'rxjs';
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
    vi.useRealTimers();
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('sets the badge to the count for a positive value', async () => {
    await firstValueFrom(makeService().set(5));

    expect(badge.set).toHaveBeenCalledWith({ count: 5 });
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('clears the badge for a count of 0', async () => {
    await firstValueFrom(makeService().set(0));

    expect(badge.clear).toHaveBeenCalledTimes(1);
    expect(badge.set).not.toHaveBeenCalled();
  });

  it('requests the badge permission once, not on every update', async () => {
    const service = makeService();
    await firstValueFrom(service.set(1));
    await firstValueFrom(service.set(2));
    await firstValueFrom(service.set(0));

    expect(badge.requestPermissions).toHaveBeenCalledTimes(1);
    expect(badge.set).toHaveBeenNthCalledWith(1, { count: 1 });
    expect(badge.set).toHaveBeenNthCalledWith(2, { count: 2 });
    expect(badge.clear).toHaveBeenCalledTimes(1);
  });

  it('does not badge when the permission is denied', async () => {
    badge.requestPermissions.mockResolvedValue({ display: 'denied' });

    await expect(firstValueFrom(makeService().set(3))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });

    expect(badge.set).not.toHaveBeenCalled();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('does not badge when the plugin reports it is unsupported', async () => {
    badge.isSupported.mockResolvedValue({ isSupported: false });

    await firstValueFrom(makeService().set(3));

    expect(badge.requestPermissions).not.toHaveBeenCalled();
    expect(badge.set).not.toHaveBeenCalled();
  });

  it('reports a rejected plugin call with a secret-safe code', async () => {
    badge.set.mockRejectedValue(new Error('boom'));

    await expect(firstValueFrom(makeService().set(4))).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'badge-update-failed' },
    });
  });

  it('normalizes a synchronous native bridge failure', async () => {
    const secret = 'access_token=native-secret';
    badge.set.mockImplementation(() => {
      throw new Error(secret);
    });

    const outcome = await firstValueFrom(makeService().set(4));

    expect(outcome).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'badge-update-failed' },
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('bounds a stalled support probe and retries readiness afterward', async () => {
    vi.useFakeTimers();
    badge.isSupported
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ isSupported: true });
    const service = makeService();
    const first = firstValueFrom(service.support());

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(
      Promise.race([first, Promise.resolve('still-pending')]),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
      diagnostic: { code: 'badge-probe-timeout' },
    });
    await expect(firstValueFrom(service.support())).resolves.toEqual({
      kind: 'supported',
    });
    expect(badge.isSupported).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled permission request', async () => {
    vi.useFakeTimers();
    badge.requestPermissions.mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const support = firstValueFrom(makeService().support());

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(
      Promise.race([support, Promise.resolve('still-pending')]),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host-rejected',
      diagnostic: { code: 'badge-probe-timeout' },
    });
  });

  it('bounds a stalled badge write', async () => {
    vi.useFakeTimers();
    badge.set.mockImplementation(() => new Promise<never>(() => undefined));
    const command = firstValueFrom(makeService().set(4));

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(
      Promise.race([command, Promise.resolve('still-pending')]),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'badge-update-timeout' },
    });
  });

  it('is a no-op off a native platform', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);

    await firstValueFrom(makeService().set(7));

    expect(badge.requestPermissions).not.toHaveBeenCalled();
    expect(badge.set).not.toHaveBeenCalled();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('is a no-op when the Badge plugin is unavailable', async () => {
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(false);

    await firstValueFrom(makeService().set(7));

    expect(badge.set).not.toHaveBeenCalled();
  });
});
