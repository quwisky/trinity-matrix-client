import {
  definePreference,
  type PreferenceDescriptor,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';

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
 * the log itself, stored with the other installation preferences. Not in the preference
 * catalog: Advanced renders it beside the actions it governs, and it is excluded from the
 * exported configuration because it describes this device.
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
