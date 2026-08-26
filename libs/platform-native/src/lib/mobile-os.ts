import { Capacitor } from '@capacitor/core';
import { isElectronRenderer } from './trinity-desktop-bridge';

/** Chromium's UA-Client-Hints, which Safari does not implement. */
interface UserAgentData {
  readonly mobile?: boolean;
}

/**
 * Whether this is running on a phone or tablet — iOS or Android.
 *
 * A PLATFORM question, not a capability one, and the distinction decides real behaviour.
 * `(pointer: coarse)` answers "is a finger driving this", which a Windows laptop with a
 * touchscreen also answers yes to; it should not be given an iOS-style bottom sheet. What
 * callers here are asking is "should this behave like a native mobile app", and only the
 * operating system answers that.
 *
 * Ordered so the authoritative signal leads and the guesswork errs toward desktop — the
 * same shape as {@link isElectronRenderer}, and for the same reason: a wrong "yes" changes
 * an interaction model, a wrong "no" leaves the app as it already was.
 *
 * 1. **Capacitor** knows exactly, on the builds where it matters most.
 * 2. **The Electron shell** reports `'web'` and runs under a Macintosh user agent, so it
 *    has to be excluded before any string test can misread it.
 * 3. **The user agent**, for mobile web and installed PWAs. `Android` is tested directly
 *    rather than through `userAgentData.mobile`, which Chrome reports as FALSE on an
 *    Android TABLET — trusting it as a negative would exclude exactly the devices this is
 *    meant to include. UA-CH is only ever read as an additional yes.
 * 4. **iPadOS 13+** reports a desktop Mac user agent. Touch points are the only thing
 *    separating an iPad from a MacBook, and a Mac reports 0.
 *
 * Guesswork on the web tier, and it will drift — user agents always do. It is checked last
 * for that reason, and every caller must be correct (if less native-feeling) when it is
 * wrong in either direction.
 */
export function isMobileOs(): boolean {
  const platform = Capacitor.getPlatform();
  if (platform === 'ios' || platform === 'android') {
    return true;
  }
  if (isElectronRenderer() || typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod/.test(ua)) {
    return true;
  }
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) {
    return true; // iPadOS in its desktop-user-agent disguise
  }
  return (
    (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
      ?.mobile === true
  );
}

/** Whether this is the native iOS shell, not Safari/PWA or an iPad-like desktop UA. */
export function isNativeIos(): boolean {
  return Capacitor.getPlatform() === 'ios';
}
