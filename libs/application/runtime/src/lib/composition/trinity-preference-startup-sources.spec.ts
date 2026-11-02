import { TestBed } from '@angular/core/testing';
import { AppearancePreferences } from '@trinity/application/appearance';
import { GifSettingsService } from '@trinity/data-access/gif';
import {
  KEEP_MENTION_RECORD_PREFERENCE,
  MentionInboxPreferences,
  provideMentionInboxPreferences,
} from '@trinity/data-access/notifications';
import {
  AccountScopeService,
  RailUnreadChatsPreference,
} from '@trinity/data-access/room-library';
import {
  DateTimeFormatService,
  FeatureFlagsService,
  KeyboardShortcutsService,
  MessageGestureSettingsService,
  PrivacySettingsService,
  ShellLayoutService,
  SystemLineSettingsService,
} from '@trinity/platform-native';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageReadOutcome,
} from '@trinity/runtime/preferences';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreferencePreparationEvidence } from './preference-startup.policy';
import { TrinityPreferenceStartupSources } from './trinity-preference-startup-sources';

const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: preferences,
}));

describe('TrinityPreferenceStartupSources', () => {
  const ready = { init: vi.fn(async () => ({ kind: 'ready' as const })) };

  beforeEach(() => {
    vi.clearAllMocks();
    preferences.get.mockRejectedValue(new Error('access_token=do-not-export'));
    TestBed.configureTestingModule({
      providers: [
        TrinityPreferenceStartupSources,
        FeatureFlagsService,
        {
          provide: AppearancePreferences,
          useValue: { hydrate: () => of({ kind: 'ready' as const }) },
        },
        { provide: ShellLayoutService, useValue: ready },
        {
          provide: PrivacySettingsService,
          useValue: { init: () => of({ kind: 'ready' as const }) },
        },
        { provide: SystemLineSettingsService, useValue: ready },
        { provide: MessageGestureSettingsService, useValue: ready },
        { provide: DateTimeFormatService, useValue: ready },
        { provide: KeyboardShortcutsService, useValue: ready },
        { provide: GifSettingsService, useValue: ready },
        {
          provide: AccountScopeService,
          useValue: { init: () => of({ kind: 'ready' as const }) },
        },
        {
          provide: MentionInboxPreferences,
          useValue: {
            init: () =>
              of({ kind: 'partial' as const, hydrated: 0, failures: [] }),
          },
        },
        {
          provide: RailUnreadChatsPreference,
          useValue: {
            init: () =>
              of({ kind: 'partial' as const, hydrated: 0, failures: [] }),
          },
        },
      ],
    });
  });

  it('carries a real initializer fallback into scoped startup evidence', async () => {
    const sources = TestBed.inject(TrinityPreferenceStartupSources).sources();

    await expect(firstValueFrom(sources['feature-flags']())).resolves.toEqual({
      kind: 'defaulted',
      code: 'feature-flags-hydration-failed',
    });
    expect(TestBed.inject(FeatureFlagsService).virtualTimeline()).toBe(true);
  });

  it('distinguishes an invalid stored value from unavailable storage', async () => {
    preferences.get.mockResolvedValue({ value: 'not-a-boolean' });
    const sources = TestBed.inject(TrinityPreferenceStartupSources).sources();

    await expect(firstValueFrom(sources['feature-flags']())).resolves.toEqual({
      kind: 'defaulted',
      code: 'feature-flags-stored-value-invalid',
    });
  });

  it('reports a partial space-rail hydration as defaulted with a recovery', async () => {
    const sources = TestBed.inject(TrinityPreferenceStartupSources).sources();

    const evidence = await firstValueFrom(sources['rail-unread']());

    expect(evidence).toMatchObject({
      kind: 'defaulted',
      code: 'rail-unread-preference-hydration-partial',
    });
    expect(evidence.kind === 'defaulted' && typeof evidence.recover).toBe(
      'function',
    );
  });

  describe('Retry on the inbox switches, whose recovery must never write', () => {
    const KEEP = KEEP_MENTION_RECORD_PREFERENCE.persistence.key;
    const down = {
      kind: 'unavailable',
      diagnostic: { code: 'storage-down' },
    } as const;
    const found = (value: unknown): PreferenceStorageReadOutcome => ({
      kind: 'found',
      payload: JSON.stringify({ version: 1, value }),
    });

    function real(reads: PreferenceStorageReadOutcome[]) {
      const write = vi.fn(() => of({ kind: 'completed' as const }));
      TestBed.overrideProvider(MentionInboxPreferences, {
        useFactory: () => new MentionInboxPreferences(),
      });
      TestBed.configureTestingModule({
        providers: [
          provideMentionInboxPreferences(),
          {
            provide: PREFERENCE_STORAGE_ADAPTER,
            useValue: {
              read: ({ key }: { key: string }) =>
                of(
                  key === KEEP ? (reads.shift() ?? down) : { kind: 'missing' },
                ),
              write,
            },
          },
        ],
      });
      const source = TestBed.inject(TrinityPreferenceStartupSources).sources()[
        'mention-inbox'
      ];
      /** What `PreferenceStartupHealthService` runs when the person presses Retry. */
      const retry = (evidence: PreferencePreparationEvidence) =>
        firstValueFrom(
          (evidence.kind === 'defaulted' && evidence.recover
            ? evidence.recover
            : source)(),
        );
      return {
        source,
        retry,
        write,
        prefs: TestBed.inject(MentionInboxPreferences),
      };
    }

    it('a stored "off" that a re-read finds stays off, with no question skipped', async () => {
      const { source, retry, write, prefs } = real([down, found(false)]);

      const evidence = await firstValueFrom(source());
      expect(evidence).toEqual({
        kind: 'defaulted',
        code: 'mention-inbox-preference-hydration-partial',
      });
      expect(prefs.recordAllowed()).toBe(false);

      await expect(retry(evidence)).resolves.toEqual({ kind: 'ready' });

      expect(write).not.toHaveBeenCalled();
      expect(prefs.keepRecord()).toBe(false);
      expect(prefs.recordAllowed()).toBe(false);
      expect(prefs.recordDeclined()).toBe(true);
    });

    it('a read that keeps failing stays not allowed, and writes nothing', async () => {
      const { source, retry, write, prefs } = real([down, down]);

      const evidence = await firstValueFrom(source());
      const retried = await retry(evidence);

      expect(retried.kind).toBe('defaulted');
      expect(write).not.toHaveBeenCalled();
      expect(prefs.recordAllowed()).toBe(false);
    });

    it('a corrupt value stays as it was on Retry: Settings is what repairs it', async () => {
      const { source, retry, write, prefs } = real([
        found('yes'),
        found('yes'),
      ]);

      const evidence = await firstValueFrom(source());
      const retried = await retry(evidence);

      expect(retried.kind).toBe('defaulted');
      expect(write).not.toHaveBeenCalled();
      expect(prefs.recordAllowed()).toBe(false);
    });
  });
});
