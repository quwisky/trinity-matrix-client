import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeIos } from './mobile-os';

const PLUGIN_NAME = 'NativeNavigation';

interface NativeNavigationPlugin {
  setGesturesEnabled(options: { enabled: boolean }): Promise<void>;
}

const nativeNavigation = registerPlugin<NativeNavigationPlugin>(PLUGIN_NAME);

/**
 * Coordinates WebKit's native back/forward gestures with Trinity-owned surfaces.
 *
 * iOS exposes both edge recognisers behind one WebView switch. The app shell supplies the
 * policy — enabled only when no dialog or registered panel needs Back — and this wrapper is
 * the single platform boundary that sends it to the same-named Swift plugin.
 *
 * Best-effort by design. Plugin registration or a bridge call can fail while the WebView
 * tears down. Neither may become an unhandled application error; the native controller that
 * carries this plugin starts fail-safe with gestures disabled, so a failed call cannot
 * recreate the navigation bypass.
 */
@Injectable({ providedIn: 'root' })
export class NativeNavigationService {
  setHistoryGesturesEnabled(enabled: boolean): void {
    try {
      if (!isNativeIos() || !Capacitor.isPluginAvailable(PLUGIN_NAME)) {
        return;
      }
      void nativeNavigation.setGesturesEnabled({ enabled }).catch(ignore);
    } catch (error) {
      ignore(error);
    }
  }
}

function ignore(error: unknown): void {
  console.debug(
    'Trinity: native navigation gesture coordination unavailable',
    error,
  );
}
