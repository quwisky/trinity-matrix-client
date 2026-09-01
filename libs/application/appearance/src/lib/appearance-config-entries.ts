import { inject, type EnvironmentProviders } from '@angular/core';
import {
  CODE_LINE_PRESENTATION_PREFERENCE,
  CODE_SIZE_PREFERENCE,
} from '@trinity/data-access/timeline';
import {
  choiceSetting,
  provideConfigEntries,
  type ConfigEntry,
} from '@trinity/platform-native';
import type { PreferenceDescriptor } from '@trinity/runtime/preferences';
import {
  AppearancePreferences,
  type AppearanceAxis,
} from './appearance-preferences';
import {
  DENSITY_PREFERENCE,
  MODE_PREFERENCE,
  TEXT_SIZE_PREFERENCE,
  THEME_PREFERENCE,
} from './design-system-appearance-preferences';

/** Register the six portable Appearance axes under one descriptor-backed config group. */
export function provideAppearanceConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => {
    const appearance = inject(AppearancePreferences);
    return [
      appearanceEntry('appearance.mode', MODE_PREFERENCE, appearance.axes.mode),
      appearanceEntry(
        'appearance.theme',
        THEME_PREFERENCE,
        appearance.axes.theme,
      ),
      appearanceEntry(
        'appearance.textSize',
        TEXT_SIZE_PREFERENCE,
        appearance.axes.textSize,
      ),
      appearanceEntry(
        'appearance.density',
        DENSITY_PREFERENCE,
        appearance.axes.density,
      ),
      appearanceEntry(
        'appearance.codeSize',
        CODE_SIZE_PREFERENCE,
        appearance.axes.codeSize,
      ),
      appearanceEntry(
        'appearance.codeLinePresentation',
        CODE_LINE_PRESENTATION_PREFERENCE,
        appearance.axes.codeLinePresentation,
      ),
    ];
  });
}

function appearanceEntry<T extends string>(
  path: string,
  descriptor: PreferenceDescriptor<T>,
  axis: AppearanceAxis<T>,
): ConfigEntry {
  if (descriptor.export !== 'portable' || descriptor.editor.kind !== 'select') {
    throw new Error(
      `Appearance config entry ${descriptor.id} is not a portable select preference`,
    );
  }
  const choices = descriptor.editor.options.map(({ value }) => value);
  const accepts = (value: string): value is T =>
    descriptor.validate(value).kind === 'accepted';
  return {
    path,
    key: descriptor.persistence.key,
    description: descriptor.editor.description,
    read: axis.value,
    reset: () => axis.set(descriptor.defaultValue),
    ...choiceSetting({
      isValid: accepts,
      options: choices,
      noun: `a supported ${descriptor.editor.label.toLowerCase()}`,
      set: axis.set,
    }),
  };
}
