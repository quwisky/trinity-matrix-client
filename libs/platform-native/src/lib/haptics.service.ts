import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

/**
 * The only file in the workspace that imports `@capacitor/haptics` (its own spec aside).
 *
 * A feature lib reaching for the plugin directly is a module-boundary violation, so the
 * plugin is wrapped here and features ask this service for a moment instead. That is also
 * why the surface is named for the moment rather than the waveform: picking between
 * `ImpactStyle.Medium` and `ImpactStyle.Heavy` at a call site would put the taste decision
 * in five places and guarantee they drift. There is exactly one such moment today — a
 * drag-to-open pane landing on open or closed — so there is exactly one method.
 *
 * Two invariants hold for every call, and both are the reason this is a service at all:
 *
 * **It only ever fires on a phone.** `Capacitor.isNativePlatform()` is false on the web and
 * false in the Electron shell, and false is the answer we want in both — a desktop has
 * nothing to vibrate. (Electron is detected elsewhere via `getTrinityDesktopBridge`, for the
 * cases where treating it as web is wrong; this is not one of them.)
 *
 * **It never rejects and never throws.** The plugin rejects on a simulator and on a device
 * with no haptic engine, which is ordinary rather than exceptional. This app is zoneless and
 * `main.ts` installs `provideBrowserGlobalErrorListeners()`, so an escaped rejection reaches
 * {@link TrinityErrorHandler} and is shown to the user as an application error. Nobody should
 * ever be told that their phone declined to buzz. Calls are therefore fire-and-forget and
 * return `void`: there is no promise for a call site to forget to catch.
 */
@Injectable({ providedIn: 'root' })
export class HapticsService {
  /**
   * A gesture just landed on a position it will keep — a swiped pane snapping open or shut.
   *
   * `impact` rather than `selectionChanged`: the tick that belongs here is one discrete
   * thump at the moment of landing, not the running series of ticks a picker wheel makes as
   * it steps (which on iOS also needs the `selectionStart`/`End` pair around it to feel
   * right). `Medium` rather than `Light` or `Heavy`: a pane is a moderately sized element,
   * `Light` is for small controls like a toggle, and `Heavy` is jarring for something that
   * fires on every swipe.
   */
  gestureCommitted(): void {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    try {
      void Haptics.impact({ style: ImpactStyle.Medium }).catch(ignore);
    } catch (error) {
      // Belt and braces: a plugin that is not registered on this platform can fail at the
      // bridge synchronously rather than by rejecting, and the caller is a pointer handler
      // mid-gesture — the one place a throw would be felt.
      ignore(error);
    }
  }
}

/**
 * Haptics are decorative. A failed one is not news, and it is certainly not an error.
 *
 * Logged at `debug` and swallowed, exactly as {@link MobileBadgeService} does for the same
 * class of failure. `debug` is verbose-level and hidden by default, so it costs a user
 * nothing, and it leaves a trace for the one question that is otherwise unanswerable: why a
 * particular device never buzzes. What matters is that the rejection is CAUGHT — an unhandled
 * one reaches `TrinityErrorHandler` and is shown as an error, which is how a missing haptic
 * engine would otherwise become a visible fault.
 */
function ignore(error: unknown): void {
  console.debug('Trinity: haptic feedback unavailable', error);
}
