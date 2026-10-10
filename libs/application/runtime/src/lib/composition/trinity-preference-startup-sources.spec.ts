import { TestBed } from '@angular/core/testing';
import { AppearancePreferences } from '@trinity/application/appearance';
import { GifSettingsService } from '@trinity/data-access/gif';
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
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
