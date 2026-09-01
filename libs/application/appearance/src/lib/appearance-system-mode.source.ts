import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject } from '@angular/core';
import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import { Observable, distinctUntilChanged, of } from 'rxjs';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** Cold host observation used by platform-neutral Appearance resolution. */
export interface AppearanceSystemModeSource {
  observe(): Observable<ResolvedThemeMode>;
}

@Injectable({ providedIn: 'root' })
export class BrowserAppearanceSystemModeSource implements AppearanceSystemModeSource {
  private readonly document = inject(DOCUMENT);

  observe(): Observable<ResolvedThemeMode> {
    const view = this.document.defaultView;
    if (!view || typeof view.matchMedia !== 'function') {
      return of('dark');
    }
    return new Observable<ResolvedThemeMode>((subscriber) => {
      const media = view.matchMedia(SYSTEM_DARK_QUERY);
      const publish = (): void =>
        subscriber.next(media.matches ? 'dark' : 'light');

      publish();
      media.addEventListener?.('change', publish);
      return () => media.removeEventListener?.('change', publish);
    }).pipe(distinctUntilChanged());
  }
}

export const APPEARANCE_SYSTEM_MODE_SOURCE =
  new InjectionToken<AppearanceSystemModeSource>(
    'APPEARANCE_SYSTEM_MODE_SOURCE',
    {
      providedIn: 'root',
      factory: () => inject(BrowserAppearanceSystemModeSource),
    },
  );
