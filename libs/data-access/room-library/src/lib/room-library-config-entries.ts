import { inject, type EnvironmentProviders } from '@angular/core';
import {
  choiceSetting,
  provideConfigEntries,
  type ConfigEntry,
} from '@trinity/platform-native';
import {
  RAIL_UNREAD_CHAT_MODES,
  RAIL_UNREAD_CHATS_PREFERENCE,
  RailUnreadChatsPreference,
  type RailUnreadChatMode,
} from './rail-unread-chats.preference';

/** The space rail's portable choice, for the config export. */
export function provideRoomLibraryConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => {
    const rail = inject(RailUnreadChatsPreference);
    const descriptor = RAIL_UNREAD_CHATS_PREFERENCE;
    const { editor } = descriptor;
    if (descriptor.export !== 'portable' || editor.kind !== 'select') {
      throw new Error(
        `Room Library config entry ${descriptor.id} is not a portable select preference`,
      );
    }
    const choice = choiceSetting({
      isValid: (value: string): value is RailUnreadChatMode =>
        descriptor.validate(value).kind === 'accepted',
      options: RAIL_UNREAD_CHAT_MODES.map(({ id }) => id),
      noun: 'a supported unread chats in the space rail choice',
      set: (value) => rail.set(value),
    });
    return [
      {
        path: 'spaceRail.unreadChats',
        key: descriptor.persistence.key,
        description: editor.description,
        read: () => rail.mode(),
        reset: () => rail.set(descriptor.defaultValue),
        ...choice,
      },
    ] satisfies readonly ConfigEntry[];
  });
}
