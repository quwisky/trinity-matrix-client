import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import { defer, from, of, type Observable } from 'rxjs';

/**
 * Capacitor implementation of the application Appearance chrome port: the status bar's content
 * on a native host, the browser's theme colour (an installed PWA's status bar) elsewhere.
 */
@Injectable({ providedIn: 'root' })
export class NativeAppearanceChromeAdapter {
  private readonly document = inject(DOCUMENT);

  apply(appearance: {
    readonly mode: ResolvedThemeMode;
    readonly color: string | null;
  }): Observable<void> {
    return defer(() => {
      if (!Capacitor.isNativePlatform()) {
        if (appearance.color) {
          // index.html's boot colours are one per Mode; both now follow the screen.
          for (const meta of this.document.querySelectorAll<HTMLMetaElement>(
            'meta[name="theme-color"]',
          )) {
            meta.content = appearance.color;
          }
        }
        return of(void 0);
      }
      if (!Capacitor.isPluginAvailable('StatusBar')) return of(void 0);
      return from(
        StatusBar.setStyle({
          style: appearance.mode === 'dark' ? Style.Dark : Style.Light,
        }),
      );
    });
  }
}
