import { inject, type EnvironmentProviders } from '@angular/core';
import {
  CODE_LINE_PRESENTATION_PREFERENCE,
  CODE_SIZE_PREFERENCE,
  TIMELINE_AVATAR_PRESENCE_PREFERENCE,
  TimelineAvatarPresencePreference,
} from '@trinity/data-access/timeline';
import {
  choiceSetting,
  flagSetting,
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
  ROOM_LIST_PREFERENCE,
  TEXT_SIZE_PREFERENCE,
  THEME_PREFERENCE,
  THEME_RENAMES,
  TRUE_BLACK_PREFERENCE,
} from './design-system-appearance-preferences';

/** Register the portable Appearance preferences, all descriptor-backed. */
export function provideAppearanceConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => {
    const appearance = inject(AppearancePreferences);
    const avatarPresence = inject(TimelineAvatarPresencePreference);
    const { editor: avatarPresenceEditor } =
      TIMELINE_AVATAR_PRESENCE_PREFERENCE;
    if (avatarPresenceEditor.kind !== 'toggle') {
      throw new Error(
        `Appearance config entry ${TIMELINE_AVATAR_PRESENCE_PREFERENCE.id} is not a toggle preference`,
      );
    }
    return [
      appearanceEntry('appearance.mode', MODE_PREFERENCE, appearance.axes.mode),
      appearanceEntry(
        'appearance.theme',
        THEME_PREFERENCE,
        appearance.axes.theme,
        THEME_RENAMES,
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
        'appearance.roomList',
        ROOM_LIST_PREFERENCE,
        appearance.axes.roomList,
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
      {
        path: 'appearance.trueBlack',
        key: TRUE_BLACK_PREFERENCE.persistence.key,
        description: appearance.axes.trueBlack.editor.description,
        read: appearance.axes.trueBlack.value,
        reset: () =>
          appearance.axes.trueBlack.set(TRUE_BLACK_PREFERENCE.defaultValue),
        ...flagSetting((on) => appearance.axes.trueBlack.set(on)),
      },
      {
        path: 'timeline.avatarPresence',
        key: TIMELINE_AVATAR_PRESENCE_PREFERENCE.persistence.key,
        description: avatarPresenceEditor.description,
        read: avatarPresence.enabled,
        reset: () =>
          avatarPresence.set(TIMELINE_AVATAR_PRESENCE_PREFERENCE.defaultValue),
        ...flagSetting((on) => avatarPresence.set(on)),
      },
    ];
  });
}

function appearanceEntry<T extends string>(
  path: string,
  descriptor: PreferenceDescriptor<T>,
  axis: AppearanceAxis<T>,
  renames: Readonly<Record<string, string>> = {},
): ConfigEntry {
  if (descriptor.export !== 'portable' || descriptor.editor.kind !== 'select') {
    throw new Error(
      `Appearance config entry ${descriptor.id} is not a portable select preference`,
    );
  }
  const choices = descriptor.editor.options.map(({ value }) => value);
  const accepts = (value: string): value is T =>
    descriptor.validate(value).kind === 'accepted';
  const choice = choiceSetting({
    isValid: accepts,
    options: choices,
    noun: `a supported ${descriptor.editor.label.toLowerCase()}`,
    set: axis.set,
  });
  return {
    path,
    key: descriptor.persistence.key,
    description: descriptor.editor.description,
    read: axis.value,
    reset: () => axis.set(descriptor.defaultValue),
    ...choice,
    validate: (value) =>
      choice.validate(
        typeof value === 'string' && Object.hasOwn(renames, value)
          ? renames[value]
          : value,
      ),
  };
}
