import {
  INSTALLATION_PREFERENCE_CONTEXT,
  definePreference,
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

export const LOCK_AFTER_CHOICES = [
  'immediately',
  '1m',
  '5m',
  '15m',
  '60m',
] as const;
export type LockAfter = (typeof LOCK_AFTER_CHOICES)[number];

function validateEnabled(value: unknown): PreferenceValidation<boolean> {
  return typeof value === 'boolean'
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'app-lock-enabled-not-boolean' },
      };
}

function validateLockAfter(value: unknown): PreferenceValidation<LockAfter> {
  return (LOCK_AFTER_CHOICES as readonly unknown[]).includes(value)
    ? { kind: 'accepted', value: value as LockAfter }
    : { kind: 'rejected', diagnostic: { code: 'app-lock-lock-after-unknown' } };
}

function version1<T extends boolean | string>(
  validate: (value: unknown) => PreferenceValidation<T>,
  code: string,
) {
  return {
    currentVersion: 1,
    migrate: (stored: StoredPreference): PreferenceValidation<T> =>
      stored.version === 1
        ? validate(stored.value)
        : { kind: 'rejected', diagnostic: { code } },
  };
}

/**
 * Settings › Security › App lock › Lock Trinity. One value per installation, excluded from
 * the exported configuration (decision 8). Not in the preference catalog: the App lock
 * group renders it beside the PIN setup it governs.
 */
export const APP_LOCK_ENABLED_PREFERENCE = definePreference({
  id: 'app-lock.enabled',
  owner: 'app-lock',
  section: 'security',
  order: 0,
  scope: 'installation',
  defaultValue: false,
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'excluded',
  editor: { kind: 'none' },
  persistence: {
    key: 'trinity.app-lock.enabled',
    migration: version1(
      validateEnabled,
      'app-lock-enabled-version-unsupported',
    ),
  },
  validate: validateEnabled,
} satisfies PreferenceDescriptor<boolean>);

/** Settings › Security › App lock › Lock after. */
export const APP_LOCK_LOCK_AFTER_PREFERENCE = definePreference<LockAfter>({
  id: 'app-lock.lock-after',
  owner: 'app-lock',
  section: 'security',
  order: 1,
  scope: 'installation',
  defaultValue: '1m',
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'excluded',
  editor: { kind: 'none' },
  persistence: {
    key: 'trinity.app-lock.lock-after',
    migration: version1(
      validateLockAfter,
      'app-lock-lock-after-version-unsupported',
    ),
  },
  validate: validateLockAfter,
});

export interface StoredAppLock {
  /**
   * The saved switch, or `unreadable` (fail closed: never collapse it to `false`; the caller
   * decides with the PIN's presence). `unreadable` whenever the switch did not load as
   * `ready`, which covers:
   * - storage reported the read as unavailable, or the adapter threw;
   * - there is no storage adapter;
   * - the saved value is not a boolean, or its version is unsupported;
   * - the value needed rewriting to the current version and the write failed;
   * - any other load state, including ones added to `PreferenceState` later;
   * - hydration errored or completed without an outcome.
   *
   * Nothing saved is `false` (off by default): a readable setting always wins.
   */
  readonly enabled: boolean | 'unreadable';
  /** The saved delay, or the default (`1m`) when it did not load as `ready`. */
  readonly lockAfter: LockAfter;
}

const UNREADABLE: StoredAppLock = { enabled: 'unreadable', lockAfter: '1m' };

/**
 * Read both settings from installation storage. Cold; emits once and never errors. Each
 * setting is judged on its own load state: a switch that is not `ready` is `unreadable`,
 * a delay that is not `ready` falls back to its default.
 */
export function readAppLockSettings(
  preferences: PreferenceStoreService,
): Observable<StoredAppLock> {
  return defer(() =>
    preferences.hydrateDescriptors(INSTALLATION_PREFERENCE_CONTEXT, [
      APP_LOCK_ENABLED_PREFERENCE,
      APP_LOCK_LOCK_AFTER_PREFERENCE,
    ]),
  ).pipe(
    take(1),
    map((): StoredAppLock => {
      const enabled = preferences.stateFor(
        APP_LOCK_ENABLED_PREFERENCE,
        INSTALLATION_PREFERENCE_CONTEXT,
      )();
      const lockAfter = preferences.stateFor(
        APP_LOCK_LOCK_AFTER_PREFERENCE,
        INSTALLATION_PREFERENCE_CONTEXT,
      )();
      return {
        enabled: enabled.kind === 'ready' ? enabled.value : 'unreadable',
        lockAfter:
          lockAfter.kind === 'ready' ? lockAfter.value : UNREADABLE.lockAfter,
      };
    }),
    catchError(() => of(UNREADABLE)),
    defaultIfEmpty(UNREADABLE),
  );
}
