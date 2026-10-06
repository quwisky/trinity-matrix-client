import { TestBed } from '@angular/core/testing';
import {
  CODE_SIZE_PREFERENCE,
  CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS,
} from '@trinity/data-access/timeline';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { THEME_CATALOG } from '@trinity/theme-foundation';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  AppearancePreferences,
  provideAppearancePreferences,
} from './appearance-preferences';
import {
  DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS,
  DENSITY_PREFERENCE,
  ROOM_LIST_PREFERENCE,
  MODE_PREFERENCE,
  THEME_PREFERENCE,
} from './design-system-appearance-preferences';

describe('Design System Appearance preference descriptors', () => {
  it('owns Mode, Theme, text size, and density with complete policy', () => {
    expect(DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS).toEqual([
      expect.objectContaining({
        id: 'design-system.appearance.mode',
        owner: 'design-system',
        section: 'appearance',
        order: 10,
        scope: 'installation',
        defaultValue: THEME_CATALOG.defaults.mode,
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'theme-mode-select',
        }),
      }),
      expect.objectContaining({
        id: 'design-system.appearance.theme',
        owner: 'design-system',
        section: 'appearance',
        order: 20,
        scope: 'installation',
        defaultValue: THEME_CATALOG.defaults.theme,
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'theme-select',
        }),
      }),
      expect.objectContaining({
        id: 'design-system.appearance.text-size',
        owner: 'design-system',
        section: 'appearance',
        order: 30,
        scope: 'installation',
        defaultValue: 'default',
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'text-scale-select',
        }),
      }),
      expect.objectContaining({
        id: 'design-system.appearance.density',
        owner: 'design-system',
        section: 'appearance',
        order: 40,
        scope: 'installation',
        defaultValue: 'cosy',
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'density-select',
        }),
      }),
      expect.objectContaining({
        id: 'design-system.appearance.room-list',
        owner: 'design-system',
        section: 'appearance',
        order: 50,
        scope: 'installation',
        defaultValue: 'rich',
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'room-list-select',
        }),
      }),
    ]);
  });

  it('offers rich and compact room lists, rich by default', () => {
    expect(ROOM_LIST_PREFERENCE.defaultValue).toBe('rich');
    expect(ROOM_LIST_PREFERENCE.editor).toEqual(
      expect.objectContaining({
        label: 'Room list',
        options: [
          { value: 'rich', label: 'Rich' },
          { value: 'compact', label: 'Compact' },
        ],
      }),
    );
  });

  it('offers cosy, compact and spacious densities', () => {
    expect(DENSITY_PREFERENCE.editor).toEqual(
      expect.objectContaining({
        options: [
          { value: 'cosy', label: 'Cosy' },
          { value: 'compact', label: 'Compact' },
          { value: 'spacious', label: 'Spacious' },
        ],
      }),
    );
  });

  it('derives Mode and Theme validation and editor options from Theme Foundation', () => {
    expect(MODE_PREFERENCE.editor).toEqual(
      expect.objectContaining({
        options: THEME_CATALOG.modes.map(({ id, label }) => ({
          value: id,
          label,
        })),
      }),
    );
    expect(THEME_PREFERENCE.editor).toEqual(
      expect.objectContaining({
        options: THEME_CATALOG.themes.map(({ id, label }) => ({
          value: id,
          label,
        })),
      }),
    );
    for (const { id } of THEME_CATALOG.themes) {
      expect(THEME_PREFERENCE.validate(id)).toEqual({
        kind: 'accepted',
        value: id,
      });
    }
    expect(THEME_PREFERENCE.validate('removed-theme').kind).toBe('rejected');
  });

  it('uses versioned Appearance identities with old keys as read-only predecessors', () => {
    expect(
      DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS.map(
        ({ persistence }) => ({
          key: persistence.key,
          legacyKeys: persistence.legacyKeys,
          version: persistence.migration.currentVersion,
        }),
      ),
    ).toEqual([
      {
        key: 'trinity.appearance.mode',
        legacyKeys: ['trinity.theme'],
        version: 1,
      },
      {
        key: 'trinity.appearance.theme',
        legacyKeys: ['trinity.palette'],
        version: 2,
      },
      {
        key: 'trinity.appearance.text-size',
        legacyKeys: ['trinity.text-scale'],
        version: 1,
      },
      {
        key: 'trinity.appearance.density',
        legacyKeys: ['trinity.density'],
        version: 1,
      },
      {
        key: 'trinity.appearance.room-list',
        legacyKeys: undefined,
        version: 1,
      },
    ]);
  });
});

describe('AppearancePreferences', () => {
  it('composes seven independently persisted axes and one recoverable warning', async () => {
    const read = vi.fn<PreferenceStorageAdapter['read']>((request) => {
      if (request.key === THEME_PREFERENCE.persistence.key) {
        return of({
          kind: 'found',
          payload: JSON.stringify({ version: 1, value: 'removed-theme' }),
        });
      }
      if (request.key === CODE_SIZE_PREFERENCE.persistence.legacyKeys?.[0]) {
        return of({ kind: 'found', payload: 'larger' });
      }
      return of({ kind: 'missing' });
    });
    const write = vi.fn<PreferenceStorageAdapter['write']>(() =>
      of({ kind: 'completed' }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideAppearancePreferences(),
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: { read, write } satisfies PreferenceStorageAdapter,
        },
      ],
    });
    const appearance = TestBed.inject(AppearancePreferences);

    expect(Object.keys(appearance.axes)).toEqual([
      'mode',
      'theme',
      'textSize',
      'density',
      'roomList',
      'codeSize',
      'codeLinePresentation',
    ]);

    const outcome = await firstValueFrom(appearance.hydrate());

    expect(outcome).toEqual({
      kind: 'partial',
      hydrated: 6,
      failures: [
        {
          preferenceId: THEME_PREFERENCE.id,
          recovery: 'reset-preference',
          diagnostic: { code: 'preference-migration-rejected' },
        },
      ],
      warning: {
        code: 'appearance-preference-hydration-partial',
        recovery: 'reset-preferences',
      },
    });
    expect(appearance.axes.theme.state()).toEqual({
      kind: 'recoverable-failure',
      value: THEME_CATALOG.defaults.theme,
      recovery: 'reset-preference',
      diagnostic: { code: 'preference-migration-rejected' },
    });
    expect(appearance.axes.codeSize.state()).toEqual({
      kind: 'ready',
      value: 'larger',
    });
    expect(appearance.value()).toEqual({
      mode: THEME_CATALOG.defaults.mode,
      theme: THEME_CATALOG.defaults.theme,
      textSize: 'default',
      density: 'cosy',
      roomList: 'rich',
      codeSize: 'larger',
      codeLinePresentation: 'auto',
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ key: CODE_SIZE_PREFERENCE.persistence.key }),
    );
  });

  it.each([
    ['trinity.appearance.theme', JSON.stringify({ version: 1, value: 'onyx' })],
    ['trinity.palette', 'onyx'],
  ])(
    'migrates a stored Onyx theme from %s to Midnight',
    async (key, payload) => {
      const read = vi.fn<PreferenceStorageAdapter['read']>((request) =>
        of(
          request.key === key
            ? { kind: 'found', payload }
            : { kind: 'missing' },
        ),
      );
      const write = vi.fn<PreferenceStorageAdapter['write']>(() =>
        of({ kind: 'completed' }),
      );
      TestBed.configureTestingModule({
        providers: [
          provideAppearancePreferences(),
          {
            provide: PREFERENCE_STORAGE_ADAPTER,
            useValue: { read, write } satisfies PreferenceStorageAdapter,
          },
        ],
      });
      const appearance = TestBed.inject(AppearancePreferences);

      await expect(firstValueFrom(appearance.hydrate())).resolves.toEqual({
        kind: 'ready',
        hydrated: 7,
      });
      expect(appearance.axes.theme.state()).toEqual({
        kind: 'ready',
        value: 'midnight',
      });
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({
          key: THEME_PREFERENCE.persistence.key,
          payload: JSON.stringify({ version: 2, value: 'midnight' }),
        }),
      );
    },
  );

  it('contributes all seven descriptors once and returns no warning when ready', async () => {
    const adapter: PreferenceStorageAdapter = {
      read: () => of({ kind: 'missing' }),
      write: () => of({ kind: 'completed' }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideAppearancePreferences(),
        { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      ],
    });
    const appearance = TestBed.inject(AppearancePreferences);

    await expect(firstValueFrom(appearance.hydrate())).resolves.toEqual({
      kind: 'ready',
      hydrated: 7,
    });
    expect([
      ...DESIGN_SYSTEM_APPEARANCE_PREFERENCE_DESCRIPTORS,
      ...CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS,
    ]).toHaveLength(7);
  });

  it('exposes descriptor editors and commits an axis only after persistence succeeds', async () => {
    const write = vi
      .fn<PreferenceStorageAdapter['write']>()
      .mockReturnValueOnce(
        of({
          kind: 'unavailable',
          diagnostic: { code: 'device-storage-unavailable' },
        }),
      )
      .mockReturnValueOnce(of({ kind: 'completed' }));
    TestBed.configureTestingModule({
      providers: [
        provideAppearancePreferences(),
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' }),
            write,
          } satisfies PreferenceStorageAdapter,
        },
      ],
    });
    const appearance = TestBed.inject(AppearancePreferences);

    expect(appearance.axes.theme.editor).toEqual(THEME_PREFERENCE.editor);

    await expect(
      firstValueFrom(appearance.axes.theme.set('amethyst')),
    ).resolves.toEqual({
      kind: 'unavailable',
      recovery: 'retry-storage',
      diagnostic: { code: 'preference-storage-write-failed' },
    });
    expect(appearance.axes.theme.value()).toBe(THEME_PREFERENCE.defaultValue);

    await expect(
      firstValueFrom(appearance.axes.theme.set('amethyst')),
    ).resolves.toEqual({ kind: 'completed' });
    expect(appearance.axes.theme.value()).toBe('amethyst');
  });

  it('recovers only failed hydration axes through their descriptor defaults', async () => {
    const stored = new Map<string, string>([
      [
        THEME_PREFERENCE.persistence.key,
        JSON.stringify({ version: 1, value: 'removed-theme' }),
      ],
      [
        MODE_PREFERENCE.persistence.key,
        JSON.stringify({ version: 1, value: 'light' }),
      ],
    ]);
    const adapter: PreferenceStorageAdapter = {
      read: (request) =>
        of(
          stored.has(request.key)
            ? { kind: 'found', payload: stored.get(request.key) ?? '' }
            : { kind: 'missing' },
        ),
      write: (request) => {
        stored.set(request.key, request.payload);
        return of({ kind: 'completed' });
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideAppearancePreferences(),
        { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      ],
    });
    const appearance = TestBed.inject(AppearancePreferences);
    const outcome = await firstValueFrom(appearance.hydrate());
    if (outcome.kind !== 'partial') {
      throw new Error('Expected partial Appearance hydration');
    }

    await expect(
      firstValueFrom(appearance.recoverHydration(outcome.failures)),
    ).resolves.toEqual({ kind: 'ready', hydrated: 7 });
    expect(appearance.axes.theme.value()).toBe(THEME_PREFERENCE.defaultValue);
    expect(appearance.axes.mode.value()).toBe('light');
  });
});
