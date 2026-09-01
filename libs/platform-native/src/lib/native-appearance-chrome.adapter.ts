import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import { defer, from, of, type Observable } from 'rxjs';

/** Capacitor implementation of the application Appearance Mode-only chrome port. */
@Injectable({ providedIn: 'root' })
export class NativeAppearanceChromeAdapter {
  apply(appearance: { readonly mode: ResolvedThemeMode }): Observable<void> {
    return defer(() => {
      if (
        !Capacitor.isNativePlatform() ||
        !Capacitor.isPluginAvailable('StatusBar')
      ) {
        return of(void 0);
      }
      return from(
        StatusBar.setStyle({
          style: appearance.mode === 'dark' ? Style.Dark : Style.Light,
        }),
      );
    });
  }
}
