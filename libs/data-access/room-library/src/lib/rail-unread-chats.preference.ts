import { Injectable, computed, inject } from '@angular/core';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  definePreference,
  type PreferenceCommandOutcome,
  type PreferenceDescriptor,
  type PreferenceFailure,
  type PreferenceHydrationOutcome,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import type { Observable } from 'rxjs';

/** What the space rail shows of the chats with new messages. */
export const RAIL_UNREAD_CHAT_MODES = Object.freeze([
  Object.freeze({ id: 'up-to-5', label: 'Up to 5' }),
  Object.freeze({ id: 'all', label: 'All' }),
  Object.freeze({ id: 'off', label: 'Off' }),
] as const);

export type RailUnreadChatMode = (typeof RAIL_UNREAD_CHAT_MODES)[number]['id'];

/** How many chats "Up to 5" lists before the "+N" entry takes the rest. */
export const RAIL_UNREAD_CHAT_LIMIT = 5;

function isRailUnreadChatMode(value: unknown): value is RailUnreadChatMode {
  return RAIL_UNREAD_CHAT_MODES.some(({ id }) => id === value);
}

function validateMode(
  value: unknown,
): PreferenceValidation<RailUnreadChatMode> {
  return isRailUnreadChatMode(value)
    ? { kind: 'accepted', value }
    : { kind: 'rejected', diagnostic: { code: 'rail-unread-chats-invalid' } };
}

function migrateMode(
  stored: StoredPreference,
): PreferenceValidation<RailUnreadChatMode> {
  return stored.version === 1
    ? validateMode(stored.value)
    : {
        kind: 'rejected',
        diagnostic: { code: 'rail-unread-chats-migration-rejected' },
      };
}

export const RAIL_UNREAD_CHATS_PREFERENCE = definePreference({
  id: 'room-library.rail-unread-chats',
  owner: 'room-library',
  section: 'space-rail',
  order: 10,
  scope: 'installation',
  defaultValue: 'up-to-5',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Unread chats in the space rail',
    description: 'Chats with new messages, newest first, under Rooms.',
    testId: 'space-rail-unread-chats',
    options: RAIL_UNREAD_CHAT_MODES.map(({ id, label }) => ({
      value: id,
      label,
    })),
  },
  persistence: {
    key: 'trinity.rail.unread-chats',
    migration: { currentVersion: 1, migrate: migrateMode },
  },
  validate: validateMode,
} satisfies PreferenceDescriptor<RailUnreadChatMode>);

/** Read model over the device's rail choice; hydrated by its own startup producer. */
@Injectable({ providedIn: 'root' })
export class RailUnreadChatsPreference {
  private readonly preferences = inject(PreferenceStoreService);
  private readonly state = this.preferences.stateFor(
    RAIL_UNREAD_CHATS_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
  );

  readonly mode = computed<RailUnreadChatMode>(() => this.state().value);

  /** Write a mode; used by the config import. Settings writes through the catalog. */
  set(candidate: unknown): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      RAIL_UNREAD_CHATS_PREFERENCE,
      INSTALLATION_PREFERENCE_CONTEXT,
      candidate,
    );
  }

  init(): Observable<PreferenceHydrationOutcome> {
    return this.preferences.hydrateDescriptors(
      INSTALLATION_PREFERENCE_CONTEXT,
      [RAIL_UNREAD_CHATS_PREFERENCE],
    );
  }

  recoverHydration(
    failures: readonly PreferenceFailure[],
  ): Observable<PreferenceHydrationOutcome> {
    return this.preferences.recoverHydration(
      INSTALLATION_PREFERENCE_CONTEXT,
      failures,
    );
  }
}
