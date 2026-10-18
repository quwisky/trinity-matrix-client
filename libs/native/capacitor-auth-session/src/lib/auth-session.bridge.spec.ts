import { Capacitor } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { authSessionAvailable, startAuthSession } from './auth-session.bridge';

const plugin = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    isPluginAvailable: vi.fn(() => true),
  },
  registerPlugin: vi.fn(() => plugin),
}));

const request = {
  url: 'https://hs.example/_matrix/client/v3/login/sso/redirect',
  callbackScheme: 'dev.trinityproject.trinity',
};
const start = () => firstValueFrom(startAuthSession(request));

describe('auth session bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Capacitor.isNativePlatform as Mock).mockReturnValue(true);
    (Capacitor.isPluginAvailable as Mock).mockReturnValue(true);
  });

  it('is available only in a native host that registered the plugin', () => {
    expect(authSessionAvailable()).toBe(true);
    (Capacitor.isPluginAvailable as Mock).mockReturnValue(false);
    expect(authSessionAvailable()).toBe(false);
    (Capacitor.isPluginAvailable as Mock).mockReturnValue(true);
    (Capacitor.isNativePlatform as Mock).mockReturnValue(false);
    expect(authSessionAvailable()).toBe(false);
  });

  it('returns the callback the session came back with', async () => {
    plugin.start.mockResolvedValue({
      url: 'dev.trinityproject.trinity://sso-callback?loginToken=t&sso_state=s',
    });

    await expect(start()).resolves.toEqual({
      kind: 'completed',
      url: 'dev.trinityproject.trinity://sso-callback?loginToken=t&sso_state=s',
    });
    expect(plugin.start).toHaveBeenCalledWith(request);
  });

  it('is unavailable when the answer is not a URL on the callback scheme', async () => {
    for (const answer of [
      { url: 'https://elsewhere.example/?loginToken=t' },
      { url: 'dev.trinityproject.trinity.next://sso-callback' },
      { url: 42 },
      null,
    ]) {
      plugin.start.mockResolvedValue(answer);
      await expect(start()).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('reports a session the person closed as cancelled', async () => {
    plugin.start.mockRejectedValue({ code: 'cancelled' });

    await expect(start()).resolves.toEqual({ kind: 'cancelled' });
  });

  it('reports any other failure as unavailable', async () => {
    plugin.start.mockRejectedValue(new Error('no window'));

    await expect(start()).resolves.toEqual({ kind: 'unavailable' });
  });

  it('never calls the plugin where it is unavailable', async () => {
    (Capacitor.isPluginAvailable as Mock).mockReturnValue(false);

    await expect(start()).resolves.toEqual({ kind: 'unavailable' });
    expect(plugin.start).not.toHaveBeenCalled();
  });
});
