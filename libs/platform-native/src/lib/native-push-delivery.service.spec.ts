import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePushDeliveryService } from './native-push-delivery.service';

const h = vi.hoisted(() => ({
  platform: 'web' as string,
  claimPresentation:
    vi.fn<
      (options: {
        accountRoute: string;
        eventId: string;
        channelId: string;
      }) => Promise<{ claimed: boolean }>
    >(),
  badgeSupport: vi.fn<() => Promise<{ supported: boolean }>>(),
  setBadge: vi.fn<(options: { count: number }) => Promise<void>>(),
  setForegroundOwner: vi.fn(
    (_options: {
      kind: 'listener' | 'presentation';
      owner: string;
      active: boolean;
    }) => Promise.resolve(),
  ),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform },
  registerPlugin: () => ({
    claimPresentation: (options: {
      accountRoute: string;
      eventId: string;
      channelId: string;
    }) => h.claimPresentation(options),
    badgeSupport: () => h.badgeSupport(),
    setBadge: (options: { count: number }) => h.setBadge(options),
    setForegroundOwner: (options: {
      kind: 'listener' | 'presentation';
      owner: string;
      active: boolean;
    }) => h.setForegroundOwner(options),
  }),
}));

describe('NativePushDeliveryService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    h.platform = 'web';
    h.claimPresentation.mockReset().mockResolvedValue({ claimed: true });
    h.badgeSupport.mockReset().mockResolvedValue({ supported: true });
    h.setBadge.mockReset().mockResolvedValue(undefined);
    h.setForegroundOwner.mockReset().mockResolvedValue(undefined);
  });

  it('bypasses delivery coordination outside Android', async () => {
    const service = TestBed.inject(NativePushDeliveryService);

    await expect(
      firstValueFrom(service.claimPresentation('account', 'event')),
    ).resolves.toBe(true);
    const lifetime = service.foreground('listener').subscribe();
    expect(h.claimPresentation).not.toHaveBeenCalled();
    expect(h.setForegroundOwner).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('is cold and returns the native claim result on Android', async () => {
    h.platform = 'android';
    const service = TestBed.inject(NativePushDeliveryService);
    const claim = service.claimPresentation('route', '$event');

    expect(h.claimPresentation).not.toHaveBeenCalled();
    await expect(firstValueFrom(claim)).resolves.toBe(true);
    expect(h.claimPresentation).toHaveBeenCalledWith({
      accountRoute: 'route',
      eventId: '$event',
      channelId: 'default',
    });
  });

  it('passes the silent foreground channel to native claims', async () => {
    h.platform = 'android';
    await expect(
      firstValueFrom(
        TestBed.inject(NativePushDeliveryService).claimPresentation(
          'route',
          '$event',
          true,
        ),
      ),
    ).resolves.toBe(true);
    expect(h.claimPresentation).toHaveBeenCalledWith({
      accountRoute: 'route',
      eventId: '$event',
      channelId: 'trinity-notifications-silent',
    });
  });

  it('clamps Android badge writes to the native range', async () => {
    h.platform = 'android';
    const service = TestBed.inject(NativePushDeliveryService);

    await firstValueFrom(service.setBadge(-4));
    await firstValueFrom(service.setBadge(10_004));

    expect(h.setBadge).toHaveBeenNthCalledWith(1, { count: 0 });
    expect(h.setBadge).toHaveBeenNthCalledWith(2, { count: 9999 });
  });

  it('maps native claim rejection to a generic error', async () => {
    h.platform = 'android';
    h.claimPresentation.mockRejectedValue(new Error('private bridge detail'));

    await expect(
      firstValueFrom(
        TestBed.inject(NativePushDeliveryService).claimPresentation(
          'route',
          '$event',
        ),
      ),
    ).rejects.toThrow('Native push delivery operation failed');
  });

  it('maps a synchronous claim bridge failure to a generic error', async () => {
    h.platform = 'android';
    h.claimPresentation.mockImplementation(() => {
      throw new Error('private bridge detail');
    });

    await expect(
      firstValueFrom(
        TestBed.inject(NativePushDeliveryService).claimPresentation(
          'route',
          '$event',
        ),
      ),
    ).rejects.toThrow('Native push delivery operation failed');
  });

  it('retains an acquired owner and releases only that owner', async () => {
    h.platform = 'android';
    const service = TestBed.inject(NativePushDeliveryService);
    const lifetime = service.foreground('presentation').subscribe();
    await vi.waitFor(() => expect(h.setForegroundOwner).toHaveBeenCalledOnce());

    const owner = h.setForegroundOwner.mock.calls[0][0].owner;
    expect(h.setForegroundOwner).toHaveBeenNthCalledWith(1, {
      kind: 'presentation',
      owner,
      active: true,
    });
    lifetime.unsubscribe();
    await vi.waitFor(() =>
      expect(h.setForegroundOwner).toHaveBeenCalledTimes(2),
    );
    expect(h.setForegroundOwner).toHaveBeenNthCalledWith(2, {
      kind: 'presentation',
      owner,
      active: false,
    });
  });

  it('cleans up when unsubscribe races a delayed native acquisition', async () => {
    h.platform = 'android';
    let resolveEnable!: () => void;
    h.setForegroundOwner.mockImplementation(
      ({ active }: { active: boolean }) =>
        active
          ? new Promise<void>((resolve) => {
              resolveEnable = resolve;
            })
          : Promise.resolve(),
    );
    const lifetime = TestBed.inject(NativePushDeliveryService)
      .foreground('listener')
      .subscribe();
    await vi.waitFor(() => expect(h.setForegroundOwner).toHaveBeenCalledOnce());
    const owner = h.setForegroundOwner.mock.calls[0][0].owner;
    lifetime.unsubscribe();
    await vi.waitFor(() =>
      expect(h.setForegroundOwner).toHaveBeenCalledTimes(2),
    );
    expect(h.setForegroundOwner).toHaveBeenLastCalledWith({
      kind: 'listener',
      owner,
      active: false,
    });

    resolveEnable();
    await vi.waitFor(() =>
      expect(h.setForegroundOwner).toHaveBeenCalledTimes(3),
    );
    expect(h.setForegroundOwner).toHaveBeenLastCalledWith({
      kind: 'listener',
      owner,
      active: false,
    });
  });

  it('contains a synchronous teardown bridge failure', async () => {
    h.platform = 'android';
    h.setForegroundOwner.mockImplementation(({ active }) => {
      if (!active) throw new Error('bridge closed');
      return Promise.resolve();
    });
    const lifetime = TestBed.inject(NativePushDeliveryService)
      .foreground('listener')
      .subscribe();
    await vi.waitFor(() => expect(h.setForegroundOwner).toHaveBeenCalledOnce());

    expect(() => lifetime.unsubscribe()).not.toThrow();
  });

  it('uses a distinct owner for every subscription', async () => {
    h.platform = 'android';
    const service = TestBed.inject(NativePushDeliveryService);
    const first = service.foreground('listener').subscribe();
    const second = service.foreground('listener').subscribe();
    await vi.waitFor(() =>
      expect(h.setForegroundOwner).toHaveBeenCalledTimes(2),
    );

    expect(h.setForegroundOwner.mock.calls[0][0].owner).not.toBe(
      h.setForegroundOwner.mock.calls[1][0].owner,
    );
    first.unsubscribe();
    second.unsubscribe();
  });
});
