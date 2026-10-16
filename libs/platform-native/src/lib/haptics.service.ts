import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

/**
 * The only file that imports `@capacitor/haptics` (its own spec aside); features ask for a
 * moment, not a waveform, so the taste decision lives in one place.
 *
 * Two invariants hold for every call:
 *
 * It only fires on a phone: `Capacitor.isNativePlatform()` is false on the web and in the
 * Electron shell, and a desktop has nothing to vibrate.
 *
 * It never rejects or throws. The plugin rejects on a simulator and on a device with no
 * haptic engine, and an escaped rejection would reach {@link TrinityErrorHandler} (the app
 * is zoneless with `provideBrowserGlobalErrorListeners()`) and show as an application error.
 * Calls are fire-and-forget and return `void`.
 */
@Injectable({ providedIn: 'root' })
export class HapticsService {
  /**
   * A gesture just landed on a position it will keep, such as a swiped pane snapping open
   * or shut. One discrete `impact`, not the running ticks of `selectionChanged`; `Medium`
   * because `Light` is for small controls and `Heavy` is jarring on every swipe.
   */
  gestureCommitted(): void {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    try {
      void Haptics.impact({ style: ImpactStyle.Medium }).catch(ignore);
    } catch (error) {
      // A plugin not registered on this platform can fail at the bridge synchronously rather
      // than by rejecting, and the caller is a pointer handler mid-gesture.
      ignore(error);
    }
  }
}

/**
 * Haptics are decorative, so a failure is logged at `debug` (hidden by default) and
 * swallowed, as {@link MobileBadgeService} does. It must be caught: an unhandled rejection
 * reaches `TrinityErrorHandler` and shows as an error.
 */
function ignore(error: unknown): void {
  console.debug('Trinity: haptic feedback unavailable', error);
}
