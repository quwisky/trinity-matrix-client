import { Injectable, effect, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { RoomsService } from '@trinity/data-access-rooms';
import {
  getTrinityDesktopBridge,
  MobileBadgeService,
} from '@trinity/platform-native';

/** Cap the badge to a sane maximum so no sink is handed an absurd value. */
const MAX_BADGE = 9999;

/** `navigator` augmented with the (optional) W3C Badging API. */
type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Mirrors the app-wide unread total ({@link RoomsService.totalUnread}) onto
 * whatever app-icon badge the current platform supports, choosing exactly ONE
 * sink by feature detection:
 *
 *  - **Electron desktop** → the `trinityDesktop.setBadgeCount` preload bridge; the
 *    main process renders it per-OS (macOS dock, Linux Unity launcher, Windows
 *    taskbar overlay).
 *  - **iOS / Android** → the native launcher badge via {@link MobileBadgeService}
 *    (a Capacitor badge plugin).
 *  - **Web / installed PWA** → the W3C Badging API
 *    (`navigator.setAppBadge`/`clearAppBadge`), which the OS surfaces on the
 *    installed-app icon (macOS, Windows, Android, ChromeOS).
 *
 * Where none is available — e.g. a plain browser tab that isn't an installed PWA —
 * it is a harmless no-op. Instantiated as a root service at startup (an app
 * initializer in `apps/trinity/src/main.ts`) so its effect stays live for the
 * whole session.
 */
@Injectable({ providedIn: 'root' })
export class AppBadgeService {
  private readonly rooms = inject(RoomsService);
  private readonly mobile = inject(MobileBadgeService);

  constructor() {
    effect(() => this.push(this.rooms.totalUnread()));
  }

  private push(total: number): void {
    const count = Math.min(Math.max(Math.trunc(total) || 0, 0), MAX_BADGE);

    // Electron desktop — the main process picks the macOS/Linux/Windows sink.
    const setBadgeCount = getTrinityDesktopBridge()?.setBadgeCount;
    if (typeof setBadgeCount === 'function') {
      setBadgeCount(count);
      return;
    }

    // iOS / Android — the native launcher badge (no-op off-native / unsupported).
    if (Capacitor.isNativePlatform()) {
      this.mobile.set(count);
      return;
    }

    // Web / installed PWA — the Badging API. Absent in a Capacitor WebView (so the
    // native branch above owns mobile) and in a non-installed tab (a no-op).
    const nav = navigator as BadgingNavigator;
    if (typeof nav.setAppBadge === 'function') {
      // Ignore rejections: the badge is decorative and may be denied by the OS.
      void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.());
    }
  }
}
