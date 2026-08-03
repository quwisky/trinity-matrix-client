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

/**
 * How large text is, as a multiplier on the ROOT font size.
 *
 * Applied as a percentage rather than a pixel value on purpose: a percentage is relative to
 * whatever the browser (or the OS, on mobile) is already set to, so someone who has raised
 * their default to 20px keeps it and gets a proportional bump. A px value would quietly
 * override an accessibility setting they had already made — the opposite of the point.
 *
 * Everything that inherits from the root scales: message bodies (`.msg__text` sets no size
 * of its own), all rendered markdown (its stylesheet is `%`/`em` throughout), and the whole
 * settings area (Tailwind's type scale is rem). Chrome that hard-codes px does NOT scale, so
 * it stays internally consistent at its own size rather than breaking — the failure mode of
 * a partial conversion is "chrome looks small next to content", not a broken layout.
 * Converting those surfaces is follow-up work, highest-traffic first.
 */
export const TRINITY_TEXT_SCALES = [
  { id: 'small', label: 'Small', percent: 87.5 },
  { id: 'default', label: 'Default', percent: 100 },
  { id: 'large', label: 'Large', percent: 112.5 },
  { id: 'larger', label: 'Larger', percent: 125 },
] as const;
/** The id of a registered text scale. */
export type TextScale = (typeof TRINITY_TEXT_SCALES)[number]['id'];
const DEFAULT_TEXT_SCALE: TextScale = 'default';

const THEME_KEY = 'trinity.theme';
const PALETTE_KEY = 'trinity.palette';
const TEXT_SCALE_KEY = 'trinity.text-scale';
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

  private readonly _textScale = signal<TextScale>(DEFAULT_TEXT_SCALE);
  /** The user's chosen text size. */
  readonly textScale = this._textScale.asReadonly();
  /** The registered scales, for the settings picker. */
  readonly textScales = TRINITY_TEXT_SCALES;

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
    try {
      const { value } = await Preferences.get({ key: TEXT_SCALE_KEY });
      if (isTextScale(value)) {
        this._textScale.set(value);
      }
    } catch {
      // No stored text scale → keep the default.
    }
    this.apply();
    this.applyPalette();
    this.applyTextScale();
  }

  /** Change + persist the mode preference, applying it immediately. */
  setPreference(pref: ThemePreference): void {
    this._preference.set(pref);
    this.apply();
    void Preferences.set({ key: THEME_KEY, value: pref }).catch(
      () => undefined,
    );
  }

  /** Change + persist the text size, applying it immediately. */
  setTextScale(scale: TextScale): void {
    this._textScale.set(scale);
    this.applyTextScale();
    void Preferences.set({ key: TEXT_SCALE_KEY, value: scale }).catch(
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

  /**
   * Reflect the active text scale on the document root.
   *
   * The DEFAULT clears the inline style rather than writing `100%`, so an unscaled app leaves
   * no footprint on <html> at all and whatever the browser or a user stylesheet says wins.
   */
  private applyTextScale(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const scale = this._textScale();
    const entry = TRINITY_TEXT_SCALES.find((s) => s.id === scale);
    if (!entry || entry.id === DEFAULT_TEXT_SCALE) {
      document.documentElement.style.removeProperty('font-size');
      return;
    }
    document.documentElement.style.setProperty(
      'font-size',
      `${entry.percent}%`,
    );
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

function isTextScale(value: string | null): value is TextScale {
  return TRINITY_TEXT_SCALES.some((s) => s.id === value);
}

function systemMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}
