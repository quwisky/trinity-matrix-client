import { TestBed } from '@angular/core/testing';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageReadOutcome,
} from '@trinity/runtime/preferences';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  KEEP_MENTION_RECORD_PREFERENCE,
  MentionInboxPreferences,
  SHOW_INBOX_PREFERENCE,
  provideMentionInboxPreferences,
} from './mention-inbox.preferences';

type Stored = Partial<Record<string, unknown>>;

function setup(stored: Stored = {}, unreadable: readonly string[] = []) {
  const adapter: PreferenceStorageAdapter = {
    read: ({ key }) =>
      of<PreferenceStorageReadOutcome>(
        unreadable.includes(key)
          ? { kind: 'unavailable', diagnostic: { code: 'storage-down' } }
          : key in stored
            ? {
                kind: 'found',
                payload: JSON.stringify({ version: 1, value: stored[key] }),
              }
            : { kind: 'missing' },
      ),
    write: () => of({ kind: 'completed' as const }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideMentionInboxPreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  return TestBed.inject(MentionInboxPreferences);
}

const SHOW = SHOW_INBOX_PREFERENCE.persistence.key;
const KEEP = KEEP_MENTION_RECORD_PREFERENCE.persistence.key;

describe('mention inbox preference descriptors', () => {
  it('are private, device-only and excluded from export', () => {
    for (const [descriptor, id, key] of [
      [SHOW_INBOX_PREFERENCE, 'notifications.inbox.show', 'trinity.inbox.show'],
      [
        KEEP_MENTION_RECORD_PREFERENCE,
        'notifications.inbox.keep-record',
        'trinity.inbox.keep-record',
      ],
    ] as const) {
      expect(descriptor).toMatchObject({
        id,
        owner: 'notifications',
        section: 'notifications',
        scope: 'installation',
        defaultValue: true,
        sensitivity: 'private',
        storage: 'device-preferences',
        export: 'excluded',
        editor: { kind: 'none' },
        persistence: { key, migration: { currentVersion: 1 } },
      });
    }
  });
});

describe('MentionInboxPreferences', () => {
  it('defaults both switches on once hydrated', async () => {
    const prefs = setup();
    await firstValueFrom(prefs.init());
    expect(prefs.showInbox()).toBe(true);
    expect(prefs.keepRecord()).toBe(true);
  });

  it('allows recording only when both are on and both were read', async () => {
    const before = setup();
    expect(before.recordAllowed()).toBe(false);

    const empty = setup();
    await firstValueFrom(empty.init());
    expect(empty.recordAllowed()).toBe(true);

    for (const stored of [
      { [SHOW]: false },
      { [KEEP]: false },
      { [SHOW]: false, [KEEP]: false },
    ]) {
      const prefs = setup(stored);
      await firstValueFrom(prefs.init());
      expect(prefs.recordAllowed()).toBe(false);
    }

    const failed = setup({ [KEEP]: 'yes' });
    await firstValueFrom(failed.init());
    expect(failed.recordAllowed()).toBe(false);

    const unavailable = setup({}, [SHOW]);
    await firstValueFrom(unavailable.init());
    expect(unavailable.recordAllowed()).toBe(false);
  });

  it('rejects a stored value that is not a boolean', async () => {
    const prefs = setup({ [SHOW]: 'yes' });
    const outcome = await firstValueFrom(prefs.init());
    expect(outcome.kind).toBe('partial');
    expect(prefs.showInbox()).toBe(true);
  });

  it('recordDeclined: false before init', () => {
    expect(setup({ [SHOW]: false }).recordDeclined()).toBe(false);
  });

  it('recordDeclined: false when both are on', async () => {
    const prefs = setup();
    await firstValueFrom(prefs.init());
    expect(prefs.recordDeclined()).toBe(false);
  });

  it('recordDeclined: true when either is explicitly off', async () => {
    for (const stored of [
      { [SHOW]: false },
      { [KEEP]: false },
      { [SHOW]: false, [KEEP]: false },
    ]) {
      const prefs = setup(stored);
      await firstValueFrom(prefs.init());
      expect(prefs.recordDeclined()).toBe(true);
    }
  });

  it('recordDeclined: false when a read failed, even beside an off switch', async () => {
    for (const prefs of [
      setup({ [KEEP]: 'yes' }),
      setup({ [SHOW]: false }, [KEEP]),
      setup({ [KEEP]: false }, [SHOW]),
    ]) {
      await firstValueFrom(prefs.init());
      expect(prefs.recordDeclined()).toBe(false);
    }
  });

  it('writes the switches', async () => {
    const prefs = setup();
    await firstValueFrom(prefs.init());
    await firstValueFrom(prefs.setKeepRecord(false));
    await firstValueFrom(prefs.setShowInbox(false));
    expect(prefs.keepRecord()).toBe(false);
    expect(prefs.showInbox()).toBe(false);
    expect(prefs.recordAllowed()).toBe(false);
    expect(prefs.recordDeclined()).toBe(true);
  });
});
