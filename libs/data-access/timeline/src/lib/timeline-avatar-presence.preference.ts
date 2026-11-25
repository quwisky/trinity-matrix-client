import { Injectable, computed, inject } from '@angular/core';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  definePreference,
  type PreferenceCommandOutcome,
  type PreferenceDescriptor,
} from '@trinity/runtime/preferences';
import type { Observable } from 'rxjs';
import { booleanMigration, validateBoolean } from './boolean-preference';

export const TIMELINE_AVATAR_PRESENCE_PREFERENCE = definePreference({
  id: 'conversations.timeline.avatar-presence',
  owner: 'conversations',
  section: 'timeline',
  order: 10,
  scope: 'installation',
  defaultValue: true,
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'toggle',
    label: 'Show presence on message avatars',
    description:
      'Show whether the sender is online or away on their avatar in the timeline.',
    testId: 'timeline-avatar-presence',
  },
  persistence: {
    key: 'trinity.timeline.avatar-presence',
    migration: booleanMigration(),
  },
  validate: validateBoolean,
} satisfies PreferenceDescriptor<boolean>);

/** Read model over the device's choice; hydrated with the appearance preferences. */
@Injectable({ providedIn: 'root' })
export class TimelineAvatarPresencePreference {
  private readonly preferences = inject(PreferenceStoreService);
  private readonly state = this.preferences.stateFor(
    TIMELINE_AVATAR_PRESENCE_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
  );

  readonly enabled = computed(() => this.state().value);

  /** Write the choice; used by the config import. Settings writes through the catalog. */
  set(candidate: unknown): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      TIMELINE_AVATAR_PRESENCE_PREFERENCE,
      INSTALLATION_PREFERENCE_CONTEXT,
      candidate,
    );
  }
}
