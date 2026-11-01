import {
  Injectable,
  computed,
  inject,
  type EnvironmentProviders,
} from '@angular/core';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  definePreference,
  providePreferenceDescriptors,
  type PreferenceCommandOutcome,
  type PreferenceDescriptor,
  type PreferenceFailure,
  type PreferenceHydrationOutcome,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import type { Observable } from 'rxjs';

function validateSwitch(
  code: string,
): (value: unknown) => PreferenceValidation<boolean> {
  return (value) =>
    typeof value === 'boolean'
      ? { kind: 'accepted', value }
      : { kind: 'rejected', diagnostic: { code: `${code}-not-boolean` } };
}

function switchPreference(
  id: string,
  order: number,
  key: string,
  code: string,
) {
  const validate = validateSwitch(code);
  return definePreference({
    id,
    owner: 'notifications',
    section: 'notifications',
    order,
    scope: 'installation',
    defaultValue: true,
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
                diagnostic: { code: `${code}-version-unsupported` },
              },
      },
    },
    validate,
  } satisfies PreferenceDescriptor<boolean>);
}

/** Whether Trinity adds the Inbox button. */
export const SHOW_INBOX_PREFERENCE = switchPreference(
  'notifications.inbox.show',
  10,
  'trinity.inbox.show',
  'inbox-show',
);

/** Whether this device keeps its record of mentions. */
export const KEEP_MENTION_RECORD_PREFERENCE = switchPreference(
  'notifications.inbox.keep-record',
  20,
  'trinity.inbox.keep-record',
  'inbox-keep-record',
);

export function provideMentionInboxPreferences(): EnvironmentProviders {
  return providePreferenceDescriptors(() => [
    SHOW_INBOX_PREFERENCE,
    KEEP_MENTION_RECORD_PREFERENCE,
  ]);
}

/** Read model over the inbox's two device switches; hydrated by its own startup producer. */
@Injectable({ providedIn: 'root' })
export class MentionInboxPreferences {
  private readonly preferences = inject(PreferenceStoreService);
  private readonly show = this.preferences.stateFor(
    SHOW_INBOX_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
  );
  private readonly keep = this.preferences.stateFor(
    KEEP_MENTION_RECORD_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
  );
  private readonly bothRead = computed(
    () => this.show().kind === 'ready' && this.keep().kind === 'ready',
  );

  readonly showInbox = computed(() => this.show().value);
  readonly keepRecord = computed(() => this.keep().value);

  /** Recording needs both switches on and both read: an unreadable one means off. */
  readonly recordAllowed = computed(
    () => this.bothRead() && this.showInbox() && this.keepRecord(),
  );

  /** The person turned a switch off. A failed read never counts, so history is never deleted on it. */
  readonly recordDeclined = computed(
    () => this.bothRead() && !(this.showInbox() && this.keepRecord()),
  );

  setShowInbox(on: boolean): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      SHOW_INBOX_PREFERENCE,
      INSTALLATION_PREFERENCE_CONTEXT,
      on,
    );
  }

  setKeepRecord(on: boolean): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      KEEP_MENTION_RECORD_PREFERENCE,
      INSTALLATION_PREFERENCE_CONTEXT,
      on,
    );
  }

  init(): Observable<PreferenceHydrationOutcome> {
    return this.preferences.hydrateDescriptors(
      INSTALLATION_PREFERENCE_CONTEXT,
      [SHOW_INBOX_PREFERENCE, KEEP_MENTION_RECORD_PREFERENCE],
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
