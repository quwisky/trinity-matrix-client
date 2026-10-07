import { afterEach, describe, expect, it, vi } from 'vitest';

const capacitor = vi.hoisted(() => ({ platform: 'web' }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => capacitor.platform },
}));

const electron = vi.hoisted(() => ({ is: false }));
vi.mock('./trinity-desktop-bridge', () => ({
  isElectronRenderer: () => electron.is,
}));

import { isNativeIos } from './mobile-os';

/**
 * A fresh evaluation: `isMobileOs` memoises for the life of the module, so each scenario
 * re-imports it. Callers get one answer per page load, which is the point.
 */
async function freshModule(): Promise<typeof import('./mobile-os')> {
  vi.resetModules();
  return import('./mobile-os');
}
async function isMobileOs(): Promise<boolean> {
  return (await freshModule()).isMobileOs();
}

/** Stand in for a device: its user agent, touch points and UA-Client-Hints. */
function device(over: {
  ua?: string;
  touchPoints?: number;
  uaDataMobile?: boolean;
}): void {
  vi.stubGlobal('navigator', {
    userAgent: over.ua ?? '',
    maxTouchPoints: over.touchPoints ?? 0,
    ...(over.uaDataMobile === undefined
      ? {}
      : { userAgentData: { mobile: over.uaDataMobile } }),
  });
}

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X200) Chrome/120',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
};

describe('isMobileOs', () => {
  afterEach(() => {
    capacitor.platform = 'web';
    electron.is = false;
    vi.unstubAllGlobals();
  });

  it('trusts Capacitor on a native build', async () => {
    device({ ua: UA.mac }); // deliberately a desktop UA — the platform wins
    for (const platform of ['ios', 'android']) {
      capacitor.platform = platform;
      expect(await isMobileOs()).toBe(true);
    }
  });

  it('is false in the Electron shell, whatever its user agent says', async () => {
    // The shell reports `web` and runs under a Macintosh UA. It has to be excluded before
    // any string test, or the iPad branch below would misread a touchscreen desktop.
    electron.is = true;
    device({ ua: UA.mac, touchPoints: 10 });

    expect(await isMobileOs()).toBe(false);
  });

  it('recognises a phone on the web', async () => {
    device({ ua: UA.android });
    expect(await isMobileOs()).toBe(true);

    device({ ua: UA.iphone });
    expect(await isMobileOs()).toBe(true);
  });

  it('recognises an Android TABLET, which UA-Client-Hints calls not-mobile', async () => {
    // The reason `Android` is tested directly rather than through `userAgentData.mobile`:
    // Chrome reports `mobile: false` on a large-screen Android, so trusting it as a
    // negative would exclude exactly the devices this exists to include.
    device({ ua: UA.androidTablet, uaDataMobile: false });

    expect(await isMobileOs()).toBe(true);
  });

  it('recognises an iPad behind its desktop user agent', async () => {
    // iPadOS 13+ reports a Macintosh UA. Touch points are the only thing that separates
    // it from a MacBook, which reports 0.
    device({ ua: UA.ipad, touchPoints: 5 });

    expect(await isMobileOs()).toBe(true);
  });

  it('is false on a Mac and on Windows', async () => {
    device({ ua: UA.mac });
    expect(await isMobileOs()).toBe(false);

    device({ ua: UA.windows });
    expect(await isMobileOs()).toBe(false);
  });

  it('is false on a Windows laptop with a touchscreen', async () => {
    // The case the whole predicate exists for: a finger can drive this, so
    // `(pointer: coarse)` is true of it — but it is not a phone, and an iOS-style bottom
    // sheet is the wrong idiom. Only asking the OS gets this right.
    device({ ua: UA.windows, touchPoints: 10 });

    expect(await isMobileOs()).toBe(false);
  });

  it('reads UA-Client-Hints only as a yes, never as a no', async () => {
    device({ ua: 'Mozilla/5.0 (Unknown)', uaDataMobile: true });
    expect(await isMobileOs()).toBe(true);

    device({ ua: UA.iphone, uaDataMobile: false });
    expect(await isMobileOs()).toBe(true);
  });

  it('answers once per module and does not re-read the user agent', async () => {
    device({ ua: UA.android });
    const { isMobileOs: memoised } = await freshModule();
    expect(memoised()).toBe(true);

    const read = vi.fn(() => UA.windows);
    vi.stubGlobal('navigator', {
      get userAgent() {
        return read();
      },
      maxTouchPoints: 0,
    });
    expect(memoised()).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('says no when there is no navigator at all', async () => {
    // Server-side rendering or a worker: the safe fallback is the desktop behaviour, which
    // works everywhere. A wrong yes would change an interaction model.
    vi.stubGlobal('navigator', undefined);

    expect(await isMobileOs()).toBe(false);
  });
});

describe('isNativeIos', () => {
  afterEach(() => {
    capacitor.platform = 'web';
    vi.unstubAllGlobals();
  });

  it('matches only the native iOS platform', () => {
    capacitor.platform = 'ios';
    expect(isNativeIos()).toBe(true);

    capacitor.platform = 'android';
    expect(isNativeIos()).toBe(false);

    capacitor.platform = 'web';
    device({ ua: UA.iphone });
    expect(isNativeIos()).toBe(false);
  });
});
