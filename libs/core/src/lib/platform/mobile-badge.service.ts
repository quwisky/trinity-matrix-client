import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Badge } from '@capawesome/capacitor-badge';

/**
 * iOS / Android app-icon (launcher) badge sink, called by {@link AppBadgeService}
 * only when running on a native Capacitor platform.
 *
 * Backed by `@capawesome/capacitor-badge`: on **iOS** the app-icon badge requires the
 * `badge` notification authorization (requested once, lazily, and cached), while on
 * **Android** launcher badges are notification/launcher-driven and need no permission
 * (their availability depends on the launcher, so treat display as best-effort).
 *
 * Kept a separate injectable so the native dependency stays out of the
 * platform-agnostic {@link AppBadgeService} and can be swapped/mocked freely. Every
 * call is fire-and-forget and MUST NOT throw: the badge is decorative, so a missing
 * plugin, an unsupported OS, a denied permission, or a rejected call is swallowed.
 */
@Injectable({ providedIn: 'root' })
export class MobileBadgeService {
  /**
   * Memoized readiness: resolves `true` once the plugin is present, supported, and
   * the badge permission has been granted. Computed (and the permission requested)
   * exactly once on first use, then reused so we never re-prompt on every update.
   */
  private ready?: Promise<boolean>;

  /**
   * Set the native launcher badge to `count` (`0` clears it). Fire-and-forget: any
   * rejection — no plugin, unsupported OS, denied permission — is swallowed. Safe
   * no-op off-native (guarded by the caller and re-checked here).
   */
  set(count: number): void {
    void this.apply(count).catch((error) => {
      // Decorative only — log at debug at most and move on.
      console.debug('Trinity: native app-icon badge update failed', error);
    });
  }

  private async apply(count: number): Promise<void> {
    if (!(await this.ensureReady())) {
      return;
    }
    await (count > 0 ? Badge.set({ count }) : Badge.clear());
  }

  private ensureReady(): Promise<boolean> {
    return (this.ready ??= this.probe());
  }

  private async probe(): Promise<boolean> {
    if (
      !Capacitor.isNativePlatform() ||
      !Capacitor.isPluginAvailable('Badge')
    ) {
      return false;
    }
    try {
      const { isSupported } = await Badge.isSupported();
      if (!isSupported) {
        return false;
      }
      // iOS: prompts for the `badge` authorization once. Android: resolves granted
      // without a prompt. Request rather than only check so first use can grant it.
      const { display } = await Badge.requestPermissions();
      return display === 'granted';
    } catch (error) {
      console.debug('Trinity: native app-icon badge unavailable', error);
      return false;
    }
  }
}
