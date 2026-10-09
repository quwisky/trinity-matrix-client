import { TestBed } from '@angular/core/testing';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PREFERENCE_STORAGE_ADAPTER,
  PreferenceStoreService,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { provideRoomLibraryPreferences } from './account-scope.service';
import {
  RAIL_UNREAD_CHATS_PREFERENCE,
  RailUnreadChatsPreference,
} from './rail-unread-chats.preference';

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
      provideRoomLibraryPreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  return TestBed.inject(RailUnreadChatsPreference);
}

describe('RAIL_UNREAD_CHATS_PREFERENCE', () => {
  it('is a portable Room Library select rendered in the Space rail section', () => {
    expect(RAIL_UNREAD_CHATS_PREFERENCE).toMatchObject({
      id: 'room-library.rail-unread-chats',
      owner: 'room-library',
      section: 'space-rail',
      scope: 'installation',
      storage: 'device-preferences',
      export: 'portable',
      defaultValue: 'up-to-5',
      editor: {
        kind: 'select',
        label: 'Unread chats in the space rail',
        testId: 'rail-unread-chats',
        options: [
          { value: 'up-to-5', label: 'Up to 5' },
          { value: 'all', label: 'All' },
          { value: 'off', label: 'Off' },
        ],
      },
      persistence: { key: 'trinity.rail.unread-chats' },
    });
  });

  it('rejects a value outside the three modes', () => {
    expect(RAIL_UNREAD_CHATS_PREFERENCE.validate('ten').kind).toBe('rejected');
  });

  it('is registered with the Room Library preferences', () => {
    setup();
    const ids = TestBed.inject(PreferenceStoreService)
      .entries('space-rail', INSTALLATION_PREFERENCE_CONTEXT)
      .map((entry) => entry.id);
    expect(ids).toEqual(['room-library.rail-unread-chats']);
  });
});

describe('RailUnreadChatsPreference', () => {
  it('reads Up to 5 until hydrated', () => {
    expect(setup().mode()).toBe('up-to-5');
  });

  it('restores the saved mode', async () => {
    const pref = setup({ version: 1, value: 'all' });
    await firstValueFrom(pref.init());
    expect(pref.mode()).toBe('all');
  });

  it('keeps the default when the stored value is not a mode', async () => {
    const pref = setup({ version: 1, value: 'ten' });
    const outcome = await firstValueFrom(pref.init());
    expect(outcome.kind).toBe('partial');
    expect(pref.mode()).toBe('up-to-5');
  });
});
