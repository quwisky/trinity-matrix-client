import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Badge } from '@capawesome/capacitor-badge';
import { firstValueFrom, of } from 'rxjs';
import { MobileBadgeService } from './mobile-badge.service';
import { CapacitorHostCapabilityAdapter } from './host-capabilities/host-capability.adapters';
import { CapacitorNotificationPresentationAdapter } from './host-capabilities/host-notification-presentation.adapters';

// Mock the native plugin: every method is a spy the tests drive per case.
vi.mock('@capawesome/capacitor-badge', () => ({
  Badge: {
    isSupported: vi.fn(),
    checkPermissions: vi.fn(),
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
    badge.checkPermissions.mockResolvedValue({ display: 'prompt' });
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
    badge.checkPermissions.mockResolvedValue({ display: 'granted' });
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

  it('bounds a stalled permission check', async () => {
    vi.useFakeTimers();
    badge.checkPermissions.mockImplementation(
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

  it('does not prompt while reporting support, so startup never waits on the person', async () => {
    vi.useFakeTimers();
    badge.requestPermissions.mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    TestBed.configureTestingModule({
      providers: [
        CapacitorHostCapabilityAdapter,
        {
          provide: CapacitorNotificationPresentationAdapter,
          useValue: {
            presentationSupport: () =>
              of({ kind: 'unavailable', reason: 'not-supported' } as const),
          },
        },
      ],
    });
    const manifest = firstValueFrom(
      TestBed.inject(CapacitorHostCapabilityAdapter).manifest(),
    );

    // Host negotiation has a 10 s budget; the manifest must be ready long before it.
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      Promise.race([manifest, Promise.resolve('still-pending')]),
    ).resolves.toMatchObject({ operations: { badge: { kind: 'supported' } } });
    expect(badge.requestPermissions).not.toHaveBeenCalled();
  });

  it('asks for permission on the first unread count and waits as long as the person takes', async () => {
    vi.useFakeTimers();
    let answer: (result: { display: 'granted' }) => void = () => undefined;
    badge.requestPermissions.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const outcome = firstValueFrom(makeService().set(2));

    await vi.advanceTimersByTimeAsync(60_000);
    answer({ display: 'granted' });

    await expect(outcome).resolves.toEqual({ kind: 'completed' });
    expect(badge.set).toHaveBeenCalledWith({ count: 2 });
  });

  it('does not prompt just to clear an empty badge', async () => {
    await expect(firstValueFrom(makeService().set(0))).resolves.toEqual({
      kind: 'completed',
    });

    expect(badge.requestPermissions).not.toHaveBeenCalled();
    expect(badge.clear).not.toHaveBeenCalled();
  });

  it('reports support when the prompt is still to come and unavailable once denied', async () => {
    const service = makeService();
    await expect(firstValueFrom(service.support())).resolves.toEqual({
      kind: 'supported',
    });

    badge.requestPermissions.mockResolvedValue({ display: 'denied' });
    await firstValueFrom(service.set(1));

    await expect(firstValueFrom(service.support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('does not prompt again once permission is already decided', async () => {
    badge.checkPermissions.mockResolvedValue({ display: 'granted' });
    const service = makeService();

    await firstValueFrom(service.set(1));

    expect(badge.requestPermissions).not.toHaveBeenCalled();
    expect(badge.set).toHaveBeenCalledWith({ count: 1 });
  });

  it('reports support as unavailable when permission was already denied', async () => {
    badge.checkPermissions.mockResolvedValue({ display: 'denied' });

    await expect(firstValueFrom(makeService().support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(badge.requestPermissions).not.toHaveBeenCalled();
  });

  it('reports a failed permission request without the timeout code', async () => {
    badge.requestPermissions.mockRejectedValue(new Error('boom'));

    await expect(firstValueFrom(makeService().set(1))).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'badge-update-failed' },
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
