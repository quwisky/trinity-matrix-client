import { Capacitor } from '@capacitor/core';
import { isElectronRenderer } from './trinity-desktop-bridge';

/** Chromium's UA-Client-Hints, which Safari does not implement. */
interface UserAgentData {
  readonly mobile?: boolean;
}

/** Whether the renderer is running inside an installed Capacitor host. */
export function isInstalledNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Whether this is running on a phone or tablet (iOS or Android).
 *
 * A platform question, not a capability one: `(pointer: coarse)` is also true on a Windows
 * touchscreen laptop, which should not get an iOS-style bottom sheet. The authoritative
 * signal leads and the guesswork errs toward desktop, since a wrong "yes" changes the
 * interaction model.
 *
 * 1. Capacitor knows exactly.
 * 2. The Electron shell reports `'web'` and runs under a Macintosh user agent, so it is
 *    excluded before any string test can misread it.
 * 3. The user agent, for mobile web and PWAs. `Android` is tested directly because
 *    `userAgentData.mobile` is false on an Android tablet; UA-CH is only read as an extra yes.
 * 4. iPadOS 13+ reports a desktop Mac user agent; only touch points separate it from a
 *    MacBook (which reports 0).
 *
 * The web tier is guesswork that will drift, so every caller must be correct (if less
 * native-feeling) when it is wrong in either direction.
 */
export function isMobileOs(): boolean {
  // Fixed for the life of the page, and every timeline row asks, so it is worked out once.
  return (mobileOs ??= detectMobileOs());
}

let mobileOs: boolean | undefined;

function detectMobileOs(): boolean {
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

/** Whether this is the native Android shell, not a mobile browser. */
export function isNativeAndroid(): boolean {
  return Capacitor.getPlatform() === 'android';
}

/** Whether this is the native iOS shell, not Safari/PWA or an iPad-like desktop UA. */
export function isNativeIos(): boolean {
  return Capacitor.getPlatform() === 'ios';
}
