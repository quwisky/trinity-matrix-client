import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import type { AppearanceValue } from './appearance-preferences';
import type { StatusAreaReading } from './appearance-status-area.source';

/** Committed Appearance after the system Mode choice has resolved. */
export type ResolvedAppearance = Omit<AppearanceValue, 'mode'> & {
  readonly mode: ResolvedThemeMode;
};

/** The complete Appearance information native chrome is allowed to observe. */
export interface NativeChromeAppearance {
  /** The Mode of the surface under the status bar, which picks the status bar's content. */
  readonly mode: ResolvedThemeMode;
  /** That surface as `#rrggbb` for a browser's theme colour; null when it could not be read. */
  readonly color: string | null;
}

/** Resolve policy only; browser and native APIs stay behind adapters. True black needs dark. */
export function resolveAppearance(
  committed: AppearanceValue,
  systemMode: ResolvedThemeMode,
): ResolvedAppearance {
  const mode = committed.mode === 'system' ? systemMode : committed.mode;
  return Object.freeze({
    ...committed,
    mode,
    trueBlack: committed.trueBlack && mode === 'dark',
  });
}

/**
 * Narrow the application projection before it crosses the native boundary. Where the page
 * reaches under the status bar, its colour there decides the Mode, so an accent banner or the
 * media viewer keeps contrast in either Mode. Where it doesn't, the host's window shows there,
 * which follows the system Mode; the colour still goes to a browser's theme colour. Without a
 * reading the resolved Mode stands in.
 */
export function toNativeChromeAppearance(
  appearance: ResolvedAppearance,
  statusArea: StatusAreaReading = { kind: 'unknown' },
  systemMode: ResolvedThemeMode = appearance.mode,
): NativeChromeAppearance {
  if (statusArea.kind === 'unknown') {
    return Object.freeze({ mode: appearance.mode, color: null });
  }
  return Object.freeze({
    mode: statusArea.underStatusBar
      ? surfaceMode(statusArea.color)
      : systemMode,
    color: statusArea.color,
  });
}

/**
 * `dark` when white content has more contrast on `#rrggbb` than black content does. The two
 * contrasts are equal at a relative luminance of about 0.179.
 */
export function surfaceMode(hex: string): ResolvedThemeMode {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05
    ? 'dark'
    : 'light';
}

/** Compare all eight resolved axes without serializing the value. */
export function sameResolvedAppearance(
  left: ResolvedAppearance,
  right: ResolvedAppearance,
): boolean {
  return (
    left.mode === right.mode &&
    left.theme === right.theme &&
    left.textSize === right.textSize &&
    left.density === right.density &&
    left.roomList === right.roomList &&
    left.codeSize === right.codeSize &&
    left.codeLinePresentation === right.codeLinePresentation &&
    left.trueBlack === right.trueBlack
  );
}
