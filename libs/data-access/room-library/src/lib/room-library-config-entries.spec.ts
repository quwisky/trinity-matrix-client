import { TestBed } from '@angular/core/testing';
import {
  AppConfigService,
  CONFIG_EXPORT_VERSION,
  configSchemaDrift,
  exportedKeysFor,
} from '@trinity/platform-native';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { provideRoomLibraryPreferences } from './account-scope.service';
import { provideRoomLibraryConfigEntries } from './room-library-config-entries';
import { RailUnreadChatsPreference } from './rail-unread-chats.preference';

async function setup() {
  const stored = new Map<string, string>();
  const write = vi.fn<PreferenceStorageAdapter['write']>((request) => {
    stored.set(request.key, request.payload);
    return of({ kind: 'completed' });
  });
  const adapter: PreferenceStorageAdapter = {
    read: (request) =>
      of(
        stored.has(request.key)
          ? {
              kind: 'found' as const,
              payload: stored.get(request.key) ?? '',
            }
          : { kind: 'missing' as const },
      ),
    write,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRoomLibraryPreferences(),
      provideRoomLibraryConfigEntries(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  const rail = TestBed.inject(RailUnreadChatsPreference);
  await firstValueFrom(rail.init());
  const config = TestBed.inject(AppConfigService);
  const entry = config.entries.find(
    ({ path }) => path === 'spaceRail.unreadChats',
  );
  if (!entry) {
    throw new Error('spaceRail.unreadChats is not registered');
  }
  return { config, entry, rail };
}

describe('Room Library config entries', () => {
  it('registers the ledger keys the lib exports, with no drift', async () => {
    const { config } = await setup();

    expect(config.entries.map(({ key }) => key)).toEqual(
      exportedKeysFor('data-access/room-library'),
    );
    expect(configSchemaDrift(config.entries)).toEqual([]);
  });

  it('reads Up to 5 by default and accepts only the three modes', async () => {
    const { entry } = await setup();

    expect(entry.read()).toBe('up-to-5');
    expect(entry.validate('all')).toEqual({ ok: true, value: 'all' });
    expect(entry.validate('ten').ok).toBe(false);
  });

  it('resets the preference to Up to 5', async () => {
    const { config, entry, rail } = await setup();
    const plan = config.validate({
      version: CONFIG_EXPORT_VERSION,
      settings: { spaceRail: { unreadChats: 'off' } },
    });
    if (!plan.ok) {
      throw new Error(plan.problems.join(' / '));
    }
    await firstValueFrom(config.apply(plan));
    expect(rail.mode()).toBe('off');

    await firstValueFrom(config.resetToDefaults());

    expect(rail.mode()).toBe('up-to-5');
    expect(entry.read()).toBe('up-to-5');
  });

  it('exports and imports the choice through the config document', async () => {
    const { config, rail } = await setup();

    expect(config.settings()).toEqual({
      spaceRail: { unreadChats: 'up-to-5' },
    });

    const plan = config.validate({
      version: CONFIG_EXPORT_VERSION,
      settings: { spaceRail: { unreadChats: 'all' } },
    });
    if (!plan.ok) {
      throw new Error(plan.problems.join(' / '));
    }
    await firstValueFrom(config.apply(plan));

    expect(rail.mode()).toBe('all');
    expect(config.settings()).toEqual({ spaceRail: { unreadChats: 'all' } });
  });

  it('names the path when an imported mode is unknown', async () => {
    const { config } = await setup();

    const plan = config.validate({
      version: CONFIG_EXPORT_VERSION,
      settings: { spaceRail: { unreadChats: 'ten' } },
    });

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.problems).toEqual([
      "spaceRail.unreadChats: 'ten' is not a supported unread chats in the space rail choice (expected up-to-5, all or off)",
    ]);
  });
});
