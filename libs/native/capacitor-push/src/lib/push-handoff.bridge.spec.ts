import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { PushHandoffBridge } from './push-handoff.bridge';

const plugin = vi.hoisted(() => ({
  setAccount: vi.fn(),
  setRooms: vi.fn(),
  removeAccount: vi.fn(),
  clear: vi.fn(),
  clearRoom: vi.fn(),
  registrationAvailable: vi.fn(),
  beginBackgroundWork: vi.fn(),
  endBackgroundWork: vi.fn(),
  setNotificationText: vi.fn(),
  clearDelivered: vi.fn(),
}));
// Recorded outside the mock: the registration happens once at import, and the runner clears
// mock call history before each test.
const registeredNames = vi.hoisted(() => [] as string[]);
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => false),
  },
  registerPlugin: vi.fn((name: string) => {
    registeredNames.push(name);
    return plugin;
  }),
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const isAvailable = Capacitor.isPluginAvailable as unknown as Mock;

function bridge(): PushHandoffBridge {
  TestBed.configureTestingModule({ providers: [PushHandoffBridge] });
  return TestBed.inject(PushHandoffBridge);
}

describe('PushHandoffBridge', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    isNative.mockReturnValue(false);
    isAvailable.mockReturnValue(false);
    for (const method of Object.values(plugin)) {
      method.mockReset().mockResolvedValue(undefined);
    }
    plugin.registrationAvailable.mockResolvedValue({ value: true });
    plugin.beginBackgroundWork.mockResolvedValue({
      id: 42,
      protectedDataAvailable: true,
      locking: false,
    });
  });

  it('registers the native plugin under the name both hosts export', () => {
    // iOS jsName and Android @CapacitorPlugin(name) are both "PushHandoff"; a rename on
    // either side leaves the bridge permanently inert without an error.
    expect(registeredNames).toEqual(['PushHandoff']);
  });

  it('is inert off a native host and calls nothing', async () => {
    const handoff = bridge();

    expect(handoff.available).toBe(false);
    await firstValueFrom(
      handoff.setAccount({
        userId: '@me:hs',
        homeserverUrl: 'https://hs',
        accessToken: 't',
        sound: true,
      }),
    );
    await firstValueFrom(handoff.setRooms('@me:hs', []));
    await firstValueFrom(handoff.removeAccount('@me:hs'));
    await firstValueFrom(handoff.clear());
    await firstValueFrom(handoff.clearRoom('@me:hs', '!a:hs'));
    expect(await firstValueFrom(handoff.registrationAvailable())).toBe(false);
    expect(await firstValueFrom(handoff.beginBackgroundWork())).toEqual({
      id: 0,
      protectedDataAvailable: true,
      locking: false,
    });
    await firstValueFrom(handoff.endBackgroundWork(0));
    expect(Object.values(plugin).some((m) => m.mock.calls.length > 0)).toBe(
      false,
    );
  });

  it('passes the access-token expiry through when the account has one', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);

    await firstValueFrom(
      bridge().setAccount({
        userId: '@me:hs',
        homeserverUrl: 'https://hs',
        accessToken: 't',
        sound: true,
        accessTokenExpiresAt: 1_760_000_000_000,
      }),
    );

    expect(plugin.setAccount).toHaveBeenCalledWith({
      userId: '@me:hs',
      homeserverUrl: 'https://hs',
      accessToken: 't',
      sound: true,
      accessTokenExpiresAt: 1_760_000_000_000,
    });
  });

  it('hands the native plugin plain objects on a native host', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const handoff = bridge();
    const rooms = [
      { roomId: '!a:hs', name: 'Team', direct: false, encrypted: false },
    ] as const;

    await firstValueFrom(
      handoff.setAccount({
        userId: '@me:hs',
        homeserverUrl: 'https://hs',
        accessToken: 't',
        sound: false,
      }),
    );
    await firstValueFrom(handoff.setRooms('@me:hs', rooms));
    await firstValueFrom(handoff.removeAccount('@me:hs'));
    await firstValueFrom(handoff.clear());
    await firstValueFrom(handoff.clearRoom('@me:hs', '!a:hs'));

    expect(isAvailable).toHaveBeenCalledWith('PushHandoff');
    expect(plugin.setAccount).toHaveBeenCalledWith({
      userId: '@me:hs',
      homeserverUrl: 'https://hs',
      accessToken: 't',
      sound: false,
    });
    expect(plugin.setRooms).toHaveBeenCalledWith({
      userId: '@me:hs',
      rooms: [
        { roomId: '!a:hs', name: 'Team', direct: false, encrypted: false },
      ],
    });
    expect(plugin.removeAccount).toHaveBeenCalledWith({ userId: '@me:hs' });
    expect(plugin.clear).toHaveBeenCalledOnce();
    expect(plugin.clearRoom).toHaveBeenCalledWith({
      userId: '@me:hs',
      roomId: '!a:hs',
    });
  });

  it('reports a native refusal as an error', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    plugin.removeAccount.mockRejectedValue(new Error('keychain locked'));

    await expect(
      firstValueFrom(bridge().removeAccount('@me:hs')),
    ).rejects.toThrow('keychain locked');
  });

  it('reports whether the native host can register for push tokens', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const handoff = bridge();

    expect(await firstValueFrom(handoff.registrationAvailable())).toBe(true);
    plugin.registrationAvailable.mockResolvedValue({ value: false });
    expect(await firstValueFrom(handoff.registrationAvailable())).toBe(false);
    expect(plugin.registrationAvailable).toHaveBeenCalledTimes(2);

    plugin.registrationAvailable.mockRejectedValue(new Error('no Firebase'));
    await expect(
      firstValueFrom(handoff.registrationAvailable()),
    ).rejects.toThrow('no Firebase');
  });

  it('begins and ends background work with the id the native host returned', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const handoff = bridge();

    const { id } = await firstValueFrom(handoff.beginBackgroundWork());
    await firstValueFrom(handoff.endBackgroundWork(id));

    expect(id).toBe(42);
    expect(plugin.beginBackgroundWork).toHaveBeenCalledOnce();
    expect(plugin.endBackgroundWork).toHaveBeenCalledWith({ id: 42 });

    plugin.beginBackgroundWork.mockRejectedValue(new Error('no main thread'));
    await expect(firstValueFrom(handoff.beginBackgroundWork())).rejects.toThrow(
      'no main thread',
    );
  });

  it('reports what the native host says about protected data', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const handoff = bridge();
    plugin.beginBackgroundWork.mockResolvedValue({
      id: 5,
      protectedDataAvailable: false,
      locking: true,
    });

    expect(await firstValueFrom(handoff.beginBackgroundWork())).toEqual({
      id: 5,
      protectedDataAvailable: false,
      locking: true,
    });
  });

  it('reads a host that reports only the id as available and not locking', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const handoff = bridge();
    plugin.beginBackgroundWork.mockResolvedValue({ id: 3 });

    expect(await firstValueFrom(handoff.beginBackgroundWork())).toEqual({
      id: 3,
      protectedDataAvailable: true,
      locking: false,
    });
  });

  describe('notification text', () => {
    it('mirrors the mode and clears delivered notifications on a native host', async () => {
      isNative.mockReturnValue(true);
      isAvailable.mockReturnValue(true);
      const handoff = bridge();

      await firstValueFrom(handoff.setNotificationText('always-hide'), {
        defaultValue: undefined,
      });
      await firstValueFrom(handoff.clearDelivered(), {
        defaultValue: undefined,
      });

      expect(plugin.setNotificationText).toHaveBeenCalledWith({
        mode: 'always-hide',
      });
      expect(plugin.clearDelivered).toHaveBeenCalledOnce();
    });

    it('is inert off a native host', async () => {
      const handoff = bridge();

      await firstValueFrom(handoff.setNotificationText('show'), {
        defaultValue: undefined,
      });
      await firstValueFrom(handoff.clearDelivered(), {
        defaultValue: undefined,
      });

      expect(plugin.setNotificationText).not.toHaveBeenCalled();
      expect(plugin.clearDelivered).not.toHaveBeenCalled();
    });

    it('reports a native refusal as an error', async () => {
      isNative.mockReturnValue(true);
      isAvailable.mockReturnValue(true);
      plugin.setNotificationText.mockRejectedValue(new Error('refused'));

      await expect(
        firstValueFrom(bridge().setNotificationText('show')),
      ).rejects.toThrow('refused');
    });
  });
});
