import {
  definePreference,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import type { PresenceState } from '@trinity/util/matrix';

/** The presence a user chose here; null means the default (online, no message). */
export type SavedOwnPresence = {
  readonly presence: PresenceState;
  readonly statusMessage: string;
} | null;

const STATES: readonly unknown[] = ['online', 'unavailable', 'offline'];

function validateOwnPresence(
  value: unknown,
): PreferenceValidation<SavedOwnPresence> {
  if (value === null) return { kind: 'accepted', value };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const { presence, statusMessage } = value as Record<string, unknown>;
    if (STATES.includes(presence) && typeof statusMessage === 'string') {
      return {
        kind: 'accepted',
        value: { presence: presence as PresenceState, statusMessage },
      };
    }
  }
  return { kind: 'rejected', diagnostic: { code: 'own-presence-rejected' } };
}

function migrateOwnPresence(
  stored: StoredPreference,
): PreferenceValidation<SavedOwnPresence> {
  return stored.version === 1
    ? validateOwnPresence(stored.value)
    : {
        kind: 'rejected',
        diagnostic: { code: 'own-presence-migration-rejected' },
      };
}

/** Per Account on this device: the presence to restore when the Account signs in again. */
export const OWN_PRESENCE_PREFERENCE = definePreference<SavedOwnPresence>({
  id: 'identity.presence.own',
  owner: 'identity',
  section: 'presence',
  order: 10,
  scope: 'account',
  defaultValue: null,
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'excluded',
  editor: { kind: 'none' },
  persistence: {
    key: 'trinity.identity.own-presence',
    migration: { currentVersion: 1, migrate: migrateOwnPresence },
  },
  validate: validateOwnPresence,
});
