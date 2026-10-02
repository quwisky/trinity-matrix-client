import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import {
  catchError,
  defer,
  forkJoin,
  from,
  map,
  of,
  type Observable,
} from 'rxjs';
import {
  AppIconAdapter,
  type AppIconName,
  type AppIconPreference,
} from './app-icon.adapter';

/** Host implementation of the application native-chrome port: status bar and app icon. */
@Injectable({ providedIn: 'root' })
export class NativeAppearanceChromeAdapter {
  private readonly appIcon = inject(AppIconAdapter);

  apply(appearance: {
    readonly mode: ResolvedThemeMode;
    readonly appIcon: AppIconName;
    readonly appIconPreference: AppIconPreference;
  }): Observable<void> {
    // The icon goes through on every host and is not held up by a status-bar failure.
    return forkJoin([
      this.statusBar(appearance.mode).pipe(catchError(() => of(void 0))),
      this.appIcon.apply(appearance.appIcon, appearance.appIconPreference),
    ]).pipe(map(() => void 0));
  }

  private statusBar(mode: ResolvedThemeMode): Observable<void> {
    return defer(() => {
      if (
        !Capacitor.isNativePlatform() ||
        !Capacitor.isPluginAvailable('StatusBar')
      ) {
        return of(void 0);
      }
      return from(
        StatusBar.setStyle({
          style: mode === 'dark' ? Style.Dark : Style.Light,
        }),
      );
    });
  }
}
