import type {
  PreferenceValidation,
  StoredPreference,
} from '@trinity/runtime/preferences';

/** Shared by this library's boolean preferences; deliberately not part of its public API. */
export function validateBoolean(value: unknown): PreferenceValidation<boolean> {
  return typeof value === 'boolean'
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'preference-expected-boolean' },
      };
}

export function booleanMigration() {
  return {
    currentVersion: 1,
    migrate: (stored: StoredPreference): PreferenceValidation<boolean> => {
      if (stored.version !== 0 && stored.version !== 1) {
        return {
          kind: 'rejected',
          diagnostic: { code: 'preference-version-unsupported' },
        };
      }
      if (typeof stored.value === 'boolean') {
        return { kind: 'accepted', value: stored.value };
      }
      if (stored.version === 0 && stored.value === 'true') {
        return { kind: 'accepted', value: true };
      }
      if (stored.version === 0 && stored.value === 'false') {
        return { kind: 'accepted', value: false };
      }
      return {
        kind: 'rejected',
        diagnostic: { code: 'preference-boolean-migration-rejected' },
      };
    },
  } as const;
}
