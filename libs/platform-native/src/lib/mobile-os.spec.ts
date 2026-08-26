import { afterEach, describe, expect, it, vi } from 'vitest';

const capacitor = vi.hoisted(() => ({ platform: 'web' }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => capacitor.platform },
}));

const electron = vi.hoisted(() => ({ is: false }));
vi.mock('./trinity-desktop-bridge', () => ({
  isElectronRenderer: () => electron.is,
}));

import { isMobileOs, isNativeIos } from './mobile-os';

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

  it('trusts Capacitor on a native build', () => {
    device({ ua: UA.mac }); // deliberately a desktop UA — the platform wins
    for (const platform of ['ios', 'android']) {
      capacitor.platform = platform;
      expect(isMobileOs()).toBe(true);
    }
  });

  it('is false in the Electron shell, whatever its user agent says', () => {
    // The shell reports `web` and runs under a Macintosh UA. It has to be excluded before
    // any string test, or the iPad branch below would misread a touchscreen desktop.
    electron.is = true;
    device({ ua: UA.mac, touchPoints: 10 });

    expect(isMobileOs()).toBe(false);
  });

  it('recognises a phone on the web', () => {
    device({ ua: UA.android });
    expect(isMobileOs()).toBe(true);

    device({ ua: UA.iphone });
    expect(isMobileOs()).toBe(true);
  });

  it('recognises an Android TABLET, which UA-Client-Hints calls not-mobile', () => {
    // The reason `Android` is tested directly rather than through `userAgentData.mobile`:
    // Chrome reports `mobile: false` on a large-screen Android, so trusting it as a
    // negative would exclude exactly the devices this exists to include.
    device({ ua: UA.androidTablet, uaDataMobile: false });

    expect(isMobileOs()).toBe(true);
  });

  it('recognises an iPad behind its desktop user agent', () => {
    // iPadOS 13+ reports a Macintosh UA. Touch points are the only thing that separates
    // it from a MacBook, which reports 0.
    device({ ua: UA.ipad, touchPoints: 5 });

    expect(isMobileOs()).toBe(true);
  });

  it('is false on a Mac and on Windows', () => {
    device({ ua: UA.mac });
    expect(isMobileOs()).toBe(false);

    device({ ua: UA.windows });
    expect(isMobileOs()).toBe(false);
  });

  it('is false on a Windows laptop with a touchscreen', () => {
    // The case the whole predicate exists for: a finger can drive this, so
    // `(pointer: coarse)` is true of it — but it is not a phone, and an iOS-style bottom
    // sheet is the wrong idiom. Only asking the OS gets this right.
    device({ ua: UA.windows, touchPoints: 10 });

    expect(isMobileOs()).toBe(false);
  });

  it('reads UA-Client-Hints only as a yes, never as a no', () => {
    device({ ua: 'Mozilla/5.0 (Unknown)', uaDataMobile: true });
    expect(isMobileOs()).toBe(true);

    device({ ua: UA.iphone, uaDataMobile: false });
    expect(isMobileOs()).toBe(true);
  });

  it('says no when there is no navigator at all', () => {
    // Server-side rendering or a worker: the safe fallback is the desktop behaviour, which
    // works everywhere. A wrong yes would change an interaction model.
    vi.stubGlobal('navigator', undefined);

    expect(isMobileOs()).toBe(false);
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
