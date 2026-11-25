import { TestBed } from '@angular/core/testing';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PREFERENCE_STORAGE_ADAPTER,
  PreferenceStoreService,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { provideConversationAppearancePreferences } from './appearance-preferences';
import {
  TIMELINE_AVATAR_PRESENCE_PREFERENCE,
  TimelineAvatarPresencePreference,
} from './timeline-avatar-presence.preference';

function setup(stored?: unknown) {
  const adapter: PreferenceStorageAdapter = {
    read: () =>
      of(
        stored === undefined
          ? { kind: 'missing' as const }
          : { kind: 'found' as const, payload: JSON.stringify(stored) },
      ),
    write: () => of({ kind: 'completed' as const }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideConversationAppearancePreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  return TestBed.inject(TimelineAvatarPresencePreference);
}

describe('TIMELINE_AVATAR_PRESENCE_PREFERENCE', () => {
  it('is a portable installation toggle that defaults on', () => {
    expect(TIMELINE_AVATAR_PRESENCE_PREFERENCE).toMatchObject({
      id: 'conversations.timeline.avatar-presence',
      owner: 'conversations',
      section: 'timeline',
      scope: 'installation',
      defaultValue: true,
      storage: 'device-preferences',
      export: 'portable',
      editor: {
        kind: 'toggle',
        label: 'Show presence on message avatars',
        testId: 'timeline-avatar-presence',
      },
      persistence: { key: 'trinity.timeline.avatar-presence' },
    });
  });

  it('accepts booleans only', () => {
    expect(TIMELINE_AVATAR_PRESENCE_PREFERENCE.validate(false)).toEqual({
      kind: 'accepted',
      value: false,
    });
    expect(TIMELINE_AVATAR_PRESENCE_PREFERENCE.validate('false').kind).toBe(
      'rejected',
    );
  });
});

describe('TimelineAvatarPresencePreference', () => {
  it('reads on by default', () => {
    expect(setup().enabled()).toBe(true);
  });

  it('restores a saved off once hydrated', async () => {
    const preference = setup({ version: 1, value: false });
    await firstValueFrom(
      TestBed.inject(PreferenceStoreService).hydrateDescriptors(
        INSTALLATION_PREFERENCE_CONTEXT,
        [TIMELINE_AVATAR_PRESENCE_PREFERENCE],
      ),
    );
    expect(preference.enabled()).toBe(false);
  });

  it('reads off after a write', async () => {
    const preference = setup();
    await firstValueFrom(preference.set(false));
    expect(preference.enabled()).toBe(false);
  });
});
