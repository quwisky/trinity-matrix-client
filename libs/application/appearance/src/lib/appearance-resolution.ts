import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import type { AppearanceValue } from './appearance-preferences';

/** Committed Appearance after the system Mode choice has resolved. */
export type ResolvedAppearance = Omit<AppearanceValue, 'mode'> & {
  readonly mode: ResolvedThemeMode;
};

/** The complete Appearance information native chrome is allowed to observe. */
export interface NativeChromeAppearance {
  readonly mode: ResolvedThemeMode;
}

/** Resolve policy only; browser and native APIs stay behind adapters. */
export function resolveAppearance(
  committed: AppearanceValue,
  systemMode: ResolvedThemeMode,
): ResolvedAppearance {
  return Object.freeze({
    ...committed,
    mode: committed.mode === 'system' ? systemMode : committed.mode,
  });
}

/** Narrow the application projection before it crosses the native boundary. */
export function toNativeChromeAppearance(
  appearance: ResolvedAppearance,
): NativeChromeAppearance {
  return Object.freeze({ mode: appearance.mode });
}

/** Compare all six resolved axes without serializing the value. */
export function sameResolvedAppearance(
  left: ResolvedAppearance,
  right: ResolvedAppearance,
): boolean {
  return (
    left.mode === right.mode &&
    left.theme === right.theme &&
    left.textSize === right.textSize &&
    left.density === right.density &&
    left.codeSize === right.codeSize &&
    left.codeLinePresentation === right.codeLinePresentation
  );
}
