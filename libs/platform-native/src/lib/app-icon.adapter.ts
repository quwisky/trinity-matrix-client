import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { defer, from, of, tap, type Observable } from 'rxjs';
import {
  getTrinityDesktopBridge,
  isElectronRenderer,
} from './trinity-desktop-bridge';

export type AppIconName = 'blurple' | 'dark';
export type AppIconPreference = AppIconName | 'system';
export type AppIconHost = 'ios' | 'android' | 'desktop' | 'web';

const PLUGIN_NAME = 'AppIcon';
const DARK_FAVICON = 'assets/icon/favicon-dark.png';

interface AppIconPlugin {
  set(options: { name: string | null }): Promise<void>;
}

const appIconPlugin = registerPlugin<AppIconPlugin>(PLUGIN_NAME);

/** Which App icon mechanism this renderer has. */
export function appIconHost(): AppIconHost {
  const platform = Capacitor.getPlatform();
  if (platform === 'ios' || platform === 'android') return platform;
  return isElectronRenderer() ? 'desktop' : 'web';
}

/**
 * Applies the App icon preference on the current host.
 *
 * Each host is called only when the icon it would show changes: iOS raises a system alert
 * on every switch and Android refreshes the launcher. Android ignores "Match system" — its
 * launcher switch is only made on an explicit user choice.
 */
@Injectable({ providedIn: 'root' })
export class AppIconAdapter {
  private readonly document = inject(DOCUMENT);
  private applied: string | undefined;

  apply(icon: AppIconName, preference: AppIconPreference): Observable<void> {
    return defer(() => {
      const host = appIconHost();
      if (host === 'android' && preference === 'system') return of(void 0);
      const target = this.target(host, icon, preference);
      if (target === this.applied) return of(void 0);
      return from(this.send(host, target)).pipe(
        tap(() => (this.applied = target)),
      );
    });
  }

  private target(
    host: AppIconHost,
    icon: AppIconName,
    preference: AppIconPreference,
  ): string {
    if (host !== 'ios') return icon;
    if (preference === 'system') return 'primary';
    return icon === 'dark' ? 'AppIconDark' : 'AppIconBlurple';
  }

  private async send(host: AppIconHost, target: string): Promise<void> {
    switch (host) {
      case 'ios':
      case 'android':
        if (Capacitor.isPluginAvailable(PLUGIN_NAME)) {
          await appIconPlugin.set({
            name: target === 'primary' ? null : target,
          });
        }
        return;
      case 'desktop':
        {
          // An absent capability (older preload) is unsupported, not a failure to retry.
          const set = getTrinityDesktopBridge()?.capabilities.appIcon?.set;
          if (set && !(await set(target as AppIconName))) {
            throw new Error('App icon was not applied');
          }
        }
        return;
      case 'web':
        this.swapFavicons(target === 'dark');
        return;
    }
  }

  /** The installed PWA icon is fixed by the manifest; only the tab icon can change. */
  private swapFavicons(dark: boolean): void {
    for (const link of this.document.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"]',
    )) {
      link.dataset['blurpleHref'] ??= link.getAttribute('href') ?? '';
      link.dataset['blurpleType'] ??= link.getAttribute('type') ?? '';
      link.setAttribute(
        'href',
        dark ? DARK_FAVICON : link.dataset['blurpleHref'],
      );
      link.setAttribute(
        'type',
        dark ? 'image/png' : link.dataset['blurpleType'],
      );
    }
  }
}
