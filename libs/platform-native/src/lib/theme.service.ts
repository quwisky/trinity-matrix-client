import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { StatusBar, Style } from '@capacitor/status-bar';

/** The mode choices offered, in the order the settings picker shows them. */
export const TRINITY_THEME_MODES = ['system', 'light', 'dark'] as const;
/** What the user picked: follow the OS, or force a mode. */
export type ThemePreference = (typeof TRINITY_THEME_MODES)[number];
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
/** The palette an untouched install uses. */
export const DEFAULT_PALETTE: Palette = 'trinity';

/**
 * How large text is, as a multiplier on the ROOT font size.
 *
 * Applied as a percentage rather than a pixel value on purpose: a percentage is relative to
 * whatever the BROWSER is already set to, so someone who has raised their default to 20px
 * keeps it and gets a proportional bump. A px value would quietly override a setting they
 * had already made. (On iOS this composes with the browser default only — the app opts into
 * nothing that lets Dynamic Type reach a WKWebView, so the OS text size does not feed in.)
 *
 * What scales is everything inheriting from the root: message bodies (`.msg__text` sets no
 * size of its own), rendered markdown (its stylesheet is `%`/`em` apart from one pinned
 * code-block caption), the composer, and every rem-based Tailwind size — which is TYPE AND
 * SPACING both, so page chrome gains proportional height as well.
 *
 * That last part is the trap. Tailwind's `w-*`/`h-*` are rem, so a rem LAYOUT slot scales
 * while hand-authored px panels inside it do not: `rooms.page.html`'s list column had to be
 * pinned to px, because as `md:w-88` it shrank below its own 352px of contents at the Small
 * setting and let the chat column paint over the room list. Any container sized in rem whose
 * children are px is the same bug — `text-scaling.spec.mts` pins the one that mattered.
 *
 * The ~147 remaining hard-coded px font sizes do NOT scale. Converting those is follow-up
 * work, highest-traffic surface first.
 */
export const TRINITY_TEXT_SCALES = [
  { id: 'small', label: 'Small', percent: 87.5 },
  { id: 'default', label: 'Default', percent: 100 },
  { id: 'large', label: 'Large', percent: 112.5 },
  { id: 'larger', label: 'Larger', percent: 125 },
] as const;
/** The id of a registered text scale. */
export type TextScale = (typeof TRINITY_TEXT_SCALES)[number]['id'];
/** The text size an untouched install uses. */
export const DEFAULT_TEXT_SCALE: TextScale = 'default';

/**
 * How large code is, as a multiplier on the optical correction already applied to it.
 *
 * A FACTOR, not a size, and deliberately not a second text scale. Code in a message is
 * sized at 85% of the text around it — a monospace face reads larger than the proportional
 * UI font at an equal computed size — and this multiplies that percentage
 * (`apps/trinity/src/rendered-markdown.scss`). Because every step stays relative, the two
 * preferences compose: Text size moves the root, Code size moves code within it, and the
 * ratio between code and its surrounding prose is preserved at every text size. An absolute
 * px value here would pin code and break Text size for it.
 *
 * Governs inline `code` and fenced blocks together, so one message never shows two sizes of
 * code. Scoped to rendered message bodies (`.msg__text--html`) — `<code>` used as app chrome,
 * such as the recovery key, is deliberately unaffected.
 */
export const TRINITY_CODE_SCALES = [
  { id: 'smaller', label: 'Smaller', factor: 0.875 },
  { id: 'default', label: 'Default', factor: 1 },
  { id: 'larger', label: 'Larger', factor: 1.15 },
] as const;
/** The id of a registered code scale. */
export type CodeScale = (typeof TRINITY_CODE_SCALES)[number]['id'];
/** The code size an untouched install uses. */
export const DEFAULT_CODE_SCALE: CodeScale = 'default';

/**
 * When a code block shows line numbers.
 *
 * Three states rather than a checkbox, because the useful default is neither on nor off: a
 * gutter on a two-line snippet is noise, and most code in a conversation is a snippet, while
 * a pasted file is exactly what someone wants to point at by line. The label names the
 * threshold instead of hiding it behind "Automatic", so the behaviour is legible without
 * opening the docs.
 *
 * `auto` is the default and writes no attribute; the stylesheet treats "no attribute" as
 * automatic and reads the line count the sanitizer records on the block. The threshold
 * itself lives with the sanitizer (LINE_NUMBER_THRESHOLD in message-view.ts) — keep this
 * label in step with it.
 */
export const TRINITY_CODE_LINE_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'auto', label: 'Blocks over 5 lines' },
  { id: 'always', label: 'Always' },
] as const;
/** The id of a registered line-number mode. */
export type CodeLineMode = (typeof TRINITY_CODE_LINE_MODES)[number]['id'];
/** The line-number mode an untouched install uses. */
export const DEFAULT_CODE_LINE_MODE: CodeLineMode = 'auto';

/** The mode preference an untouched install uses: follow the OS. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

const THEME_KEY = 'trinity.theme';
const PALETTE_KEY = 'trinity.palette';
const TEXT_SCALE_KEY = 'trinity.text-scale';
const CODE_SCALE_KEY = 'trinity.code-scale';
const CODE_LINES_KEY = 'trinity.code-lines';
/** Custom property on <html> the rendered-markdown stylesheet multiplies by. */
const CODE_SCALE_PROP = '--trinity-code-scale';
/** Attribute on <html> naming the line-number mode; absent for the automatic default. */
const CODE_LINES_ATTR = 'data-code-lines';
/**
 * Class toggled on <html>; its PRESENCE means dark. Light is the `:root` default and
 * dark is layered under `.dark` (see apps/trinity/src/theme/variables.scss), so a
 * resolved dark theme ADDS this class and light removes it.
 */
const DARK_CLASS = 'dark';
/** Attribute on <html> naming the active palette; absent for the default palette. */
const PALETTE_ATTR = 'data-theme';

/**
 * Owns the app's appearance across five orthogonal axes, each reflected on <html>:
 *   • mode       — light/dark: persists the user's preference, resolves `system` against
 *     `prefers-color-scheme`, and toggles {@link DARK_CLASS} on the document root;
 *   • palette    — the named colour scheme: persists the choice and reflects it as the
 *     {@link PALETTE_ATTR} attribute (absent for the default palette);
 *   • text size  — a percentage written as `font-size` on the root;
 *   • code size  — a factor written as {@link CODE_SCALE_PROP}, multiplying the size of
 *     code inside rendered messages;
 *   • code line numbers — when a block shows a numbering gutter, as the
 *     {@link CODE_LINES_ATTR} attribute (absent for the automatic default).
 * Each is exposed as a signal so the settings UI can bind the current choice, and each
 * writes NOTHING at its default, so an untouched app leaves no footprint on <html>.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>(
    DEFAULT_THEME_PREFERENCE,
  );
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

  private readonly _codeScale = signal<CodeScale>(DEFAULT_CODE_SCALE);
  /** The user's chosen code size. */
  readonly codeScale = this._codeScale.asReadonly();
  /** The registered code scales, for the settings picker. */
  readonly codeScales = TRINITY_CODE_SCALES;

  private readonly _codeLines = signal<CodeLineMode>(DEFAULT_CODE_LINE_MODE);
  /** When code blocks show line numbers. */
  readonly codeLines = this._codeLines.asReadonly();
  /** The registered line-number modes, for the settings picker. */
  readonly codeLineModes = TRINITY_CODE_LINE_MODES;

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
      if (isThemePreference(value)) {
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
    try {
      const { value } = await Preferences.get({ key: CODE_SCALE_KEY });
      if (isCodeScale(value)) {
        this._codeScale.set(value);
      }
    } catch {
      // No stored code scale → keep the default.
    }
    try {
      const { value } = await Preferences.get({ key: CODE_LINES_KEY });
      if (isCodeLineMode(value)) {
        this._codeLines.set(value);
      }
    } catch {
      // No stored line-number mode → keep the default.
    }
    this.apply();
    this.applyPalette();
    this.applyTextScale();
    this.applyCodeScale();
    this.applyCodeLines();
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

  /** Change + persist the code size, applying it immediately. */
  setCodeScale(scale: CodeScale): void {
    this._codeScale.set(scale);
    this.applyCodeScale();
    void Preferences.set({ key: CODE_SCALE_KEY, value: scale }).catch(
      () => undefined,
    );
  }

  /** Change + persist when code blocks show line numbers, applying it immediately. */
  setCodeLines(mode: CodeLineMode): void {
    this._codeLines.set(mode);
    this.applyCodeLines();
    void Preferences.set({ key: CODE_LINES_KEY, value: mode }).catch(
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

  /**
   * Reflect the active code scale on the document root.
   *
   * The DEFAULT clears the property rather than writing `1`, so an unscaled app leaves no
   * footprint on <html> and the declaration in variables.scss is what "Default" means —
   * one place to change it, and nothing to keep in step.
   */
  private applyCodeScale(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const scale = this._codeScale();
    const entry = TRINITY_CODE_SCALES.find((s) => s.id === scale);
    if (!entry || entry.id === DEFAULT_CODE_SCALE) {
      document.documentElement.style.removeProperty(CODE_SCALE_PROP);
      return;
    }
    document.documentElement.style.setProperty(
      CODE_SCALE_PROP,
      String(entry.factor),
    );
  }

  /**
   * Reflect the line-number mode on the document root.
   *
   * The DEFAULT (`auto`) writes no attribute: the stylesheet's unqualified rule already IS
   * the automatic behaviour, reading the line count the sanitizer records on each block. So
   * only the two states that override it leave a footprint.
   */
  private applyCodeLines(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const mode = this._codeLines();
    if (mode === DEFAULT_CODE_LINE_MODE) {
      document.documentElement.removeAttribute(CODE_LINES_ATTR);
    } else {
      document.documentElement.setAttribute(CODE_LINES_ATTR, mode);
    }
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

// Exported as well as used on the way in from storage: the config import has to hold a
// pasted value to exactly the standard a stored one is held to, and a second set of rules
// living beside these is how the two drift.

/** True when `value` names a mode this build applies. */
export function isThemePreference(
  value: string | null,
): value is ThemePreference {
  return TRINITY_THEME_MODES.some((mode) => mode === value);
}

/** True when `value` is a registered palette id. */
export function isPalette(value: string | null): value is Palette {
  return TRINITY_PALETTES.some((p) => p.id === value);
}

/** True when `value` is a registered text scale id. */
export function isTextScale(value: string | null): value is TextScale {
  return TRINITY_TEXT_SCALES.some((s) => s.id === value);
}

/** True when `value` is a registered code scale id. */
export function isCodeScale(value: string | null): value is CodeScale {
  return TRINITY_CODE_SCALES.some((s) => s.id === value);
}

/** True when `value` is a registered line-number mode id. */
export function isCodeLineMode(value: string | null): value is CodeLineMode {
  return TRINITY_CODE_LINE_MODES.some((m) => m.id === value);
}

function systemMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}
