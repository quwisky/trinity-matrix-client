import type { EnvironmentProviders } from '@angular/core';
import {
  definePreference,
  providePreferenceDescriptors,
  type PreferenceDescriptor,
  type PreferenceValidation,
  type PreferenceValue,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import {
  THEME_CATALOG,
  type ThemeId,
  type ThemeMode,
} from '@trinity/theme-foundation';

export const TEXT_SIZE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'small', label: 'Small', percent: 87.5 }),
  Object.freeze({ id: 'default', label: 'Default', percent: 100 }),
  Object.freeze({ id: 'large', label: 'Large', percent: 112.5 }),
  Object.freeze({ id: 'larger', label: 'Larger', percent: 125 }),
] as const);

export type TextSize = (typeof TEXT_SIZE_OPTIONS)[number]['id'];

export const DENSITY_OPTIONS = Object.freeze([
  Object.freeze({ id: 'cosy', label: 'Cosy' }),
  Object.freeze({ id: 'compact', label: 'Compact' }),
] as const);

export type AppearanceDensity = (typeof DENSITY_OPTIONS)[number]['id'];

export const MODE_PREFERENCE = definePreference({
  id: 'design-system.appearance.mode',
  owner: 'design-system',
  section: 'appearance',
  order: 10,
  scope: 'installation',
  defaultValue: THEME_CATALOG.defaults.mode,
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Mode',
    description: 'Follow the system color scheme or choose light or dark.',
    testId: 'theme-mode-select',
    options: THEME_CATALOG.modes.map(({ id, label }) => ({ value: id, label })),
  },
  persistence: {
    key: 'trinity.appearance.mode',
    legacyKeys: ['trinity.theme'],
    migration: closedStringMigration(isThemeMode),
  },
  validate: closedStringValidation(isThemeMode, 'appearance-mode-invalid'),
} satisfies PreferenceDescriptor<ThemeMode>);

export const THEME_PREFERENCE = definePreference({
  id: 'design-system.appearance.theme',
  owner: 'design-system',
  section: 'appearance',
  order: 20,
  scope: 'installation',
  defaultValue: THEME_CATALOG.defaults.theme,
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Theme',
    description:
      'Choose the visual token set independently from light or dark Mode.',
    testId: 'theme-select',
    options: THEME_CATALOG.themes.map(({ id, label }) => ({
      value: id,
      label,
    })),
  },
  persistence: {
    key: 'trinity.appearance.theme',
    legacyKeys: ['trinity.palette'],
    migration: closedStringMigration(isThemeId),
  },
  validate: closedStringValidation(isThemeId, 'appearance-theme-invalid'),
} satisfies PreferenceDescriptor<ThemeId>);

export const TEXT_SIZE_PREFERENCE = definePreference({
  id: 'design-system.appearance.text-size',
  owner: 'design-system',
  section: 'appearance',
  order: 30,
  scope: 'installation',
  defaultValue: 'default',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Text size',
    description:
      'Scale application text relative to the browser or device default.',
    testId: 'text-scale-select',
    options: TEXT_SIZE_OPTIONS.map(({ id, label }) => ({ value: id, label })),
  },
  persistence: {
    key: 'trinity.appearance.text-size',
    legacyKeys: ['trinity.text-scale'],
    migration: closedStringMigration(isTextSize),
  },
  validate: closedStringValidation(isTextSize, 'appearance-text-size-invalid'),
} satisfies PreferenceDescriptor<TextSize>);

export const DENSITY_PREFERENCE = definePreference({
  id: 'design-system.appearance.density',
  owner: 'design-system',
  section: 'appearance',
  order: 40,
  scope: 'installation',
  defaultValue: 'cosy',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Conversation density',
    description: 'Choose comfortable or compact application spacing.',
    testId: 'density-select',
    options: DENSITY_OPTIONS.map(({ id, label }) => ({ value: id, label })),
  },
  persistence: {
    key: 'trinity.appearance.density',
    legacyKeys: ['trinity.density'],
    migration: closedStringMigration(isAppearanceDensity),
  },
  validate: closedStringValidation(
    isAppearanceDensity,
    'appearance-density-invalid',
  ),
} satisfies PreferenceDescriptor<AppearanceDensity>);

export const DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS: readonly PreferenceDescriptor<PreferenceValue>[] =
  [MODE_PREFERENCE, THEME_PREFERENCE, TEXT_SIZE_PREFERENCE, DENSITY_PREFERENCE];

export function provideDesignSystemAppearancePreferences(): EnvironmentProviders {
  return providePreferenceDescriptors(
    () => DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS,
  );
}

function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_CATALOG.modes.some(({ id }) => id === value);
}

function isThemeId(value: unknown): value is ThemeId {
  return THEME_CATALOG.themes.some(({ id }) => id === value);
}

function isTextSize(value: unknown): value is TextSize {
  return TEXT_SIZE_OPTIONS.some(({ id }) => id === value);
}

function isAppearanceDensity(value: unknown): value is AppearanceDensity {
  return DENSITY_OPTIONS.some(({ id }) => id === value);
}

function closedStringValidation<T extends string>(
  accepts: (value: unknown) => value is T,
  diagnosticCode: string,
): (value: unknown) => PreferenceValidation<T> {
  return (value) =>
    accepts(value)
      ? { kind: 'accepted', value }
      : { kind: 'rejected', diagnostic: { code: diagnosticCode } };
}

function closedStringMigration<T extends string>(
  accepts: (value: unknown) => value is T,
) {
  return {
    currentVersion: 1,
    migrate: (stored: StoredPreference): PreferenceValidation<T> => {
      if (
        (stored.version === 0 || stored.version === 1) &&
        accepts(stored.value)
      ) {
        return { kind: 'accepted', value: stored.value };
      }
      return {
        kind: 'rejected',
        diagnostic: { code: 'appearance-preference-migration-rejected' },
      };
    },
  } as const;
}
