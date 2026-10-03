import type { AppIconName, AppIconPreference } from '@trinity/platform-native';
import type { ResolvedThemeMode } from '@trinity/theme-foundation';
import type { AppearanceValue } from './appearance-preferences';

/** Committed Appearance after the system Mode choice has resolved. */
export type ResolvedAppearance = Omit<AppearanceValue, 'mode' | 'appIcon'> & {
  readonly mode: ResolvedThemeMode;
  readonly appIcon: AppIconName;
  readonly appIconPreference: AppIconPreference;
};

/** The complete Appearance information native chrome is allowed to observe. */
export interface NativeChromeAppearance {
  readonly mode: ResolvedThemeMode;
  readonly appIcon: AppIconName;
  /** Unresolved choice: hosts that must not switch automatically (Android) skip `system`. */
  readonly appIconPreference: AppIconPreference;
}

/** Resolve policy only; browser and native APIs stay behind adapters. */
export function resolveAppearance(
  committed: AppearanceValue,
  systemMode: ResolvedThemeMode,
): ResolvedAppearance {
  const { appIcon, ...rest } = committed;
  return Object.freeze({
    ...rest,
    mode: committed.mode === 'system' ? systemMode : committed.mode,
    appIcon:
      appIcon === 'system'
        ? systemMode === 'dark'
          ? 'dark'
          : 'blurple'
        : appIcon,
    appIconPreference: appIcon,
  });
}

/** Narrow the application projection before it crosses the native boundary. */
export function toNativeChromeAppearance(
  appearance: ResolvedAppearance,
): NativeChromeAppearance {
  return Object.freeze({
    mode: appearance.mode,
    appIcon: appearance.appIcon,
    appIconPreference: appearance.appIconPreference,
  });
}

/** Compare all resolved axes without serializing the value. */
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
    left.codeLinePresentation === right.codeLinePresentation &&
    left.appIcon === right.appIcon &&
    left.appIconPreference === right.appIconPreference
  );
}
