import {
  INSTALLATION_PREFERENCE_CONTEXT,
  definePreference,
  type PreferenceCommandOutcome,
  type PreferenceDescriptor,
  type PreferenceStoreService,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import {
  catchError,
  defaultIfEmpty,
  defer,
  map,
  of,
  take,
  type Observable,
} from 'rxjs';

function validateKeepLog(value: unknown): PreferenceValidation<boolean> {
  return typeof value === 'boolean'
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'diagnostics-keep-log-not-boolean' },
      };
}

/**
 * Settings › Advanced › Diagnostics › Keep a diagnostic log. One value per installation, like
 * the log itself. Not in the preference catalog: Advanced renders it beside the actions it
 * governs, and it is excluded from the exported configuration because it describes this
 * device.
 */
export const KEEP_DIAGNOSTIC_LOG_PREFERENCE = definePreference({
  id: 'diagnostics.keep-log',
  owner: 'diagnostics',
  section: 'advanced',
  order: 0,
  scope: 'installation',
  defaultValue: true,
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'excluded',
  editor: { kind: 'none' },
  persistence: {
    key: 'trinity.diagnostics.keep-log',
    migration: {
      currentVersion: 1,
      migrate: (stored: StoredPreference) =>
        stored.version === 1
          ? validateKeepLog(stored.value)
          : {
              kind: 'rejected',
              diagnostic: { code: 'diagnostics-keep-log-version-unsupported' },
            },
    },
  },
  validate: validateKeepLog,
} satisfies PreferenceDescriptor<boolean>);

/** "Keep a diagnostic log" as read from storage, or `unreadable` when it couldn't be. */
export type StoredKeepLog = 'on' | 'off' | 'unreadable';

/**
 * Read the setting from installation storage. Emits once and never errors: a failed read
 * is `unreadable`, which callers treat as off for the session. Cold.
 */
export function readKeepLogSetting(
  preferences: PreferenceStoreService,
): Observable<StoredKeepLog> {
  return defer(() =>
    preferences.hydrateDescriptors(INSTALLATION_PREFERENCE_CONTEXT, [
      KEEP_DIAGNOSTIC_LOG_PREFERENCE,
    ]),
  ).pipe(
    take(1),
    map((outcome): StoredKeepLog => {
      if (outcome.kind !== 'ready') {
        return 'unreadable';
      }
      return preferences.stateFor(
        KEEP_DIAGNOSTIC_LOG_PREFERENCE,
        INSTALLATION_PREFERENCE_CONTEXT,
      )().value === false
        ? 'off'
        : 'on';
    }),
    catchError(() => of<StoredKeepLog>('unreadable')),
    defaultIfEmpty<StoredKeepLog, StoredKeepLog>('unreadable'),
  );
}

/** Save the setting for this installation. Cold. */
export function saveKeepLogSetting(
  preferences: PreferenceStoreService,
  keep: boolean,
): Observable<PreferenceCommandOutcome> {
  return preferences.setPreference(
    KEEP_DIAGNOSTIC_LOG_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
    keep,
  );
}
