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
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => false),
  },
  registerPlugin: vi.fn(() => plugin),
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
    expect(Object.values(plugin).some((m) => m.mock.calls.length > 0)).toBe(
      false,
    );
  });

  it('hands the native plugin plain objects on a native host', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const handoff = bridge();
    const rooms = [{ roomId: '!a:hs', name: 'Team', direct: false }] as const;

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
      rooms: [{ roomId: '!a:hs', name: 'Team', direct: false }],
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
});
