import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

/** What the user picked: follow the OS, or force a mode. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** The mode actually applied after resolving `system`. */
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'trinity.theme';
/**
 * Class toggled on <html>; its presence is dark (light is the :root default). This
 * is Ionic's own dark-palette class (global.scss imports dark.class.css), so toggling
 * it switches both the Trinity vars and Ionic's surface tokens together.
 */
const DARK_CLASS = 'ion-palette-dark';

/**
 * Owns the app's light/dark appearance: persists the user's preference, resolves
 * `system` against `prefers-color-scheme`, and applies the result by toggling a
 * class on the document root. The dark palette is the `:root` default, so a
 * resolved dark theme just removes the light class. Exposed as signals so the
 * settings UI can bind the current choice.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>('system');
  /** The user's chosen preference (system/light/dark). */
  readonly preference = this._preference.asReadonly();

  private readonly _resolved = signal<ResolvedTheme>('dark');
  /** The mode actually applied right now (system resolved to light/dark). */
  readonly resolved = this._resolved.asReadonly();

  private media: MediaQueryList | null = null;
  private readonly onSystemChange = (): void => {
    // Only the OS-following preference reacts to a system theme change.
    if (this._preference() === 'system') {
      this.apply();
    }
  };

  /** Read the saved preference and apply it. Call once at app startup. */
  async init(): Promise<void> {
    if (!this.media) {
      // Guard against a double init re-registering the system listener.
      this.media = systemMedia();
      this.media?.addEventListener?.('change', this.onSystemChange);
    }
    try {
      const { value } = await Preferences.get({ key: THEME_KEY });
      if (isPreference(value)) {
        this._preference.set(value);
      }
    } catch {
      // No stored preference (or storage unavailable) → keep the default.
    }
    this.apply();
  }

  /** Change + persist the preference, applying it immediately. */
  setPreference(pref: ThemePreference): void {
    this._preference.set(pref);
    this.apply();
    void Preferences.set({ key: THEME_KEY, value: pref }).catch(
      () => undefined,
    );
  }

  /** Resolve the active mode and reflect it on the document root. */
  private apply(): void {
    const systemDark = this.media ? this.media.matches : true; // default dark
    const pref = this._preference();
    const resolved: ResolvedTheme =
      pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
    this._resolved.set(resolved);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle(
        DARK_CLASS,
        resolved === 'dark',
      );
    }
  }
}

function isPreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function systemMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}
