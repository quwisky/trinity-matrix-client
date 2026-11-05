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

function diagnosticsSwitch(
  name: string,
  key: string,
  order: number,
  defaultValue: boolean,
) {
  const validate = (value: unknown): PreferenceValidation<boolean> =>
    typeof value === 'boolean'
      ? { kind: 'accepted', value }
      : {
          kind: 'rejected',
          diagnostic: { code: `diagnostics-${name}-not-boolean` },
        };
  return definePreference({
    id: `diagnostics.${name}`,
    owner: 'diagnostics',
    section: 'advanced',
    order,
    scope: 'installation',
    defaultValue,
    sensitivity: 'private',
    storage: 'device-preferences',
    export: 'excluded',
    editor: { kind: 'none' },
    persistence: {
      key,
      migration: {
        currentVersion: 1,
        migrate: (stored: StoredPreference) =>
          stored.version === 1
            ? validate(stored.value)
            : {
                kind: 'rejected',
                diagnostic: { code: `diagnostics-${name}-version-unsupported` },
              },
      },
    },
    validate,
  } satisfies PreferenceDescriptor<boolean>);
}

/**
 * Settings › Advanced › Diagnostics › Keep a diagnostic log. One value per installation, like
 * the log itself. Not in the preference catalog: Advanced renders it beside the actions it
 * governs, and it is excluded from the exported configuration because it describes this
 * device.
 */
export const KEEP_DIAGNOSTIC_LOG_PREFERENCE = diagnosticsSwitch(
  'keep-log',
  'trinity.diagnostics.keep-log',
  0,
  true,
);

/**
 * Settings › Advanced › Diagnostics › Detailed logging: the log also keeps matrix-js-sdk's
 * debug lines. Off by default, because those lines cost formatting and storage all the time.
 */
export const DETAILED_DIAGNOSTIC_LOG_PREFERENCE = diagnosticsSwitch(
  'detailed-log',
  'trinity.diagnostics.detailed-log',
  1,
  false,
);

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

/** Read "Detailed logging" for this installation; off when it can't be read. Cold. */
export function readDetailedLogSetting(
  preferences: PreferenceStoreService,
): Observable<boolean> {
  return defer(() =>
    preferences.hydrateDescriptors(INSTALLATION_PREFERENCE_CONTEXT, [
      DETAILED_DIAGNOSTIC_LOG_PREFERENCE,
    ]),
  ).pipe(
    take(1),
    map(
      (outcome) =>
        outcome.kind === 'ready' &&
        preferences.stateFor(
          DETAILED_DIAGNOSTIC_LOG_PREFERENCE,
          INSTALLATION_PREFERENCE_CONTEXT,
        )().value === true,
    ),
    catchError(() => of(false)),
    defaultIfEmpty(false),
  );
}

/** Save "Detailed logging" for this installation. Cold. */
export function saveDetailedLogSetting(
  preferences: PreferenceStoreService,
  detailed: boolean,
): Observable<PreferenceCommandOutcome> {
  return preferences.setPreference(
    DETAILED_DIAGNOSTIC_LOG_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
    detailed,
  );
}
