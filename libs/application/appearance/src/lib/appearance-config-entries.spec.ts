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
import { provideAppearanceConfigEntries } from './appearance-config-entries';
import {
  APPEARANCE_PREFERENCE_DESCRIPTORS,
  AppearancePreferences,
  provideAppearancePreferences,
} from './appearance-preferences';

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
  TestBed.configureTestingModule({
    providers: [
      provideAppearancePreferences(),
      provideAppearanceConfigEntries(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
    ],
  });
  const appearance = TestBed.inject(AppearancePreferences);
  await firstValueFrom(appearance.hydrate());
  return {
    appearance,
    config: TestBed.inject(AppConfigService),
    write,
  };
}

describe('Appearance config entries', () => {
  it('derives six portable paths, keys, choices, and defaults from descriptors', async () => {
    const { config } = await setup();
    const descriptorKeys = APPEARANCE_PREFERENCE_DESCRIPTORS.map(
      ({ persistence }) => persistence.key,
    ).sort();

    expect(config.entries.map(({ path }) => path)).toEqual([
      'appearance.codeLinePresentation',
      'appearance.codeSize',
      'appearance.density',
      'appearance.mode',
      'appearance.textSize',
      'appearance.theme',
    ]);
    expect(config.entries.map(({ key }) => key).sort()).toEqual(descriptorKeys);
    expect(configSchemaDrift(config.entries)).toEqual([]);
    expect(
      [
        ...exportedKeysFor('application/appearance'),
        ...exportedKeysFor('data-access/timeline'),
      ].sort(),
    ).toEqual(descriptorKeys);
  });

  it('exports and imports current Appearance names without legacy vocabulary', async () => {
    const { appearance, config, write } = await setup();

    expect(config.settings()).toEqual({
      appearance: {
        codeLinePresentation: 'auto',
        codeSize: 'default',
        density: 'cosy',
        mode: 'system',
        textSize: 'default',
        theme: 'trinity',
      },
    });
    expect(config.exportJson()).not.toContain('palette');
    expect(config.exportJson()).not.toContain('textScale');
    expect(config.exportJson()).not.toContain('codeScale');
    expect(config.export().version).toBe(CONFIG_EXPORT_VERSION);

    const plan = config.validate({
      version: CONFIG_EXPORT_VERSION,
      settings: {
        appearance: {
          mode: 'dark',
          theme: 'amethyst',
          textSize: 'large',
          density: 'compact',
          codeSize: 'larger',
          codeLinePresentation: 'always',
        },
      },
    });
    if (!plan.ok) {
      throw new Error(plan.problems.join(' / '));
    }
    await firstValueFrom(config.apply(plan));

    expect(appearance.value()).toEqual({
      mode: 'dark',
      theme: 'amethyst',
      textSize: 'large',
      density: 'compact',
      codeSize: 'larger',
      codeLinePresentation: 'always',
    });
    expect(write.mock.calls.map(([request]) => request.key).sort()).toEqual(
      APPEARANCE_PREFERENCE_DESCRIPTORS.map(
        ({ persistence }) => persistence.key,
      ).sort(),
    );
    expect(write.mock.calls.map(([request]) => request.key)).not.toContain(
      'trinity.palette',
    );
  });

  it('migrates all six version 1 Theme paths into current Appearance entries', async () => {
    const { appearance, config } = await setup();

    const plan = config.validate({
      version: 1,
      settings: {
        theme: {
          mode: 'dark',
          palette: 'amethyst',
          textScale: 'large',
          density: 'compact',
          codeScale: 'larger',
          codeLineNumbers: 'always',
        },
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.warnings).toEqual([
      'Appearance settings from portable format version 1 were migrated to their current paths.',
    ]);
    expect(plan.ok && plan.changes.map(({ path }) => path)).toEqual([
      'appearance.codeLinePresentation',
      'appearance.codeSize',
      'appearance.density',
      'appearance.mode',
      'appearance.textSize',
      'appearance.theme',
    ]);
    if (!plan.ok) {
      throw new Error(plan.problems.join(' / '));
    }
    await firstValueFrom(config.apply(plan));
    expect(appearance.value()).toEqual({
      mode: 'dark',
      theme: 'amethyst',
      textSize: 'large',
      density: 'compact',
      codeSize: 'larger',
      codeLinePresentation: 'always',
    });
  });

  it('uses descriptor validation for imported values', async () => {
    const { config } = await setup();

    const plan = config.validate({
      version: CONFIG_EXPORT_VERSION,
      settings: { appearance: { theme: 'removed-theme' } },
    });

    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.problems).toEqual([
      "appearance.theme: 'removed-theme' is not a supported theme (expected trinity, amethyst or onyx)",
    ]);
  });
});
