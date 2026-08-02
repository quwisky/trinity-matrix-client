import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { StatusBar, Style } from '@capacitor/status-bar';

/** What the user picked: follow the OS, or force a mode. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** The mode actually applied after resolving `system`. */
export type ResolvedTheme = 'light' | 'dark';

/**
 * The named colour schemes shipped with the app. A palette is orthogonal to
 * light/dark — every palette works in both modes. Adding one is two steps: a CSS
 * block in apps/trinity/src/theme/variables.scss (keyed on `[data-theme='<id>']`)
 * and an entry here. See docs/architecture/ui-and-theming.md.
 *
 * `trinity` is the default and applies no `data-theme` attribute (the `:root`
 * defaults in variables.scss).
 */
export const TRINITY_PALETTES = [
  { id: 'trinity', label: 'Trinity' },
  { id: 'amethyst', label: 'Amethyst' },
] as const;
/** The id of a registered palette. */
export type Palette = (typeof TRINITY_PALETTES)[number]['id'];
const DEFAULT_PALETTE: Palette = 'trinity';

const THEME_KEY = 'trinity.theme';
const PALETTE_KEY = 'trinity.palette';
/**
 * Class toggled on <html>; its PRESENCE means dark. Light is the `:root` default and
 * dark is layered under `.dark` (see apps/trinity/src/theme/variables.scss), so a
 * resolved dark theme ADDS this class and light removes it.
 */
const DARK_CLASS = 'dark';
/** Attribute on <html> naming the active palette; absent for the default palette. */
const PALETTE_ATTR = 'data-theme';

/**
 * Owns the app's appearance across two orthogonal axes:
 *   • mode    — light/dark: persists the user's preference, resolves `system` against
 *     `prefers-color-scheme`, and toggles {@link DARK_CLASS} on the document root;
 *   • palette — the named colour scheme: persists the choice and reflects it as the
 *     {@link PALETTE_ATTR} attribute (absent for the default palette).
 * Both are exposed as signals so the settings UI can bind the current choices.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>('system');
  /** The user's chosen preference (system/light/dark). */
  readonly preference = this._preference.asReadonly();

  private readonly _resolved = signal<ResolvedTheme>('dark');
  /** The mode actually applied right now (system resolved to light/dark). */
  readonly resolved = this._resolved.asReadonly();

  private readonly _palette = signal<Palette>(DEFAULT_PALETTE);
  /** The active colour palette. */
  readonly palette = this._palette.asReadonly();

  /** The palettes available to offer in the UI. */
  readonly palettes = TRINITY_PALETTES;

  private media: MediaQueryList | null = null;
  private readonly onSystemChange = (): void => {
    // Only the OS-following preference reacts to a system theme change.
    if (this._preference() === 'system') {
      this.apply();
    }
  };

  /** Read the saved preferences and apply them. Call once at app startup. */
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
    try {
      const { value } = await Preferences.get({ key: PALETTE_KEY });
      if (isPalette(value)) {
        this._palette.set(value);
      }
    } catch {
      // No stored palette → keep the default.
    }
    this.apply();
    this.applyPalette();
  }

  /** Change + persist the mode preference, applying it immediately. */
  setPreference(pref: ThemePreference): void {
    this._preference.set(pref);
    this.apply();
    void Preferences.set({ key: THEME_KEY, value: pref }).catch(
      () => undefined,
    );
  }

  /** Change + persist the colour palette, applying it immediately. */
  setPalette(palette: Palette): void {
    this._palette.set(palette);
    this.applyPalette();
    void Preferences.set({ key: PALETTE_KEY, value: palette }).catch(
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
    this.applyNativeChrome(resolved);
  }

  /** Reflect the active palette on the document root (default palette = no attribute). */
  private applyPalette(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const palette = this._palette();
    if (palette === DEFAULT_PALETTE) {
      document.documentElement.removeAttribute(PALETTE_ATTR);
    } else {
      document.documentElement.setAttribute(PALETTE_ATTR, palette);
    }
  }

  /**
   * Match the native status bar to the resolved theme so the device chrome follows
   * along (no-op on web). `Style.Dark` renders light icons/text for a dark bar;
   * `Style.Light` renders dark icons/text for a light bar. Best-effort.
   */
  private applyNativeChrome(resolved: ResolvedTheme): void {
    if (
      !Capacitor.isNativePlatform() ||
      !Capacitor.isPluginAvailable('StatusBar')
    ) {
      return;
    }
    void StatusBar.setStyle({
      style: resolved === 'dark' ? Style.Dark : Style.Light,
    }).catch(() => undefined);
  }
}

function isPreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isPalette(value: string | null): value is Palette {
  return TRINITY_PALETTES.some((p) => p.id === value);
}

function systemMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}
