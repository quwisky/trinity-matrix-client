import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AppearanceEffects,
  AppearancePreferences,
  THEME_PREFERENCE,
  provideAppearancePreferences,
} from '@trinity/application/appearance';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { NEVER, defer, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppearanceSettingsController } from './appearance-settings.controller';

describe('AppearanceSettingsController', () => {
  it('does not start a command while hydration is still reading preferences', () => {
    const write = vi.fn<PreferenceStorageAdapter['write']>(() =>
      of({ kind: 'completed' }),
    );
    let effectsSubscribed = false;
    const run = vi.fn(() =>
      defer(() => {
        effectsSubscribed = true;
        return NEVER;
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        AppearanceSettingsController,
        provideAppearancePreferences(),
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => NEVER,
            write,
          } satisfies PreferenceStorageAdapter,
        },
        {
          provide: AppearanceEffects,
          useValue: {
            resolved: signal(undefined).asReadonly(),
            run,
          } satisfies Pick<AppearanceEffects, 'resolved' | 'run'>,
        },
      ],
    });
    const controller = TestBed.inject(AppearanceSettingsController);

    expect(controller.hydrationBusy()).toBe(true);
    controller.update('theme', 'amethyst');

    expect(write).not.toHaveBeenCalled();
    expect(effectsSubscribed).toBe(false);
  });

  it('keeps the committed selection visible and retries the same failed candidate', () => {
    const write = vi
      .fn<PreferenceStorageAdapter['write']>()
      .mockReturnValueOnce(
        of({
          kind: 'unavailable',
          diagnostic: { code: 'device-storage-unavailable' },
        }),
      )
      .mockReturnValueOnce(of({ kind: 'completed' }));
    const controller = setup({
      read: () => of({ kind: 'missing' }),
      write,
    });

    controller.update('theme', 'amethyst');

    expect(controller.axes.theme.value()).toBe(THEME_PREFERENCE.defaultValue);
    expect(controller.status.theme.failed()).toBe(true);
    expect(controller.status.theme.busy()).toBe(false);

    controller.retry('theme');

    expect(write).toHaveBeenCalledTimes(2);
    expect(controller.axes.theme.value()).toBe('amethyst');
    expect(controller.status.theme.failed()).toBe(false);
  });

  it('reduces partial hydration to one warning and clears it after recovery', () => {
    let themePayload = JSON.stringify({
      version: 1,
      value: 'removed-theme',
    });
    const controller = setup({
      read: (request) =>
        of(
          request.key === THEME_PREFERENCE.persistence.key
            ? {
                kind: 'found' as const,
                payload: themePayload,
              }
            : { kind: 'missing' as const },
        ),
      write: (request) => {
        if (request.key === THEME_PREFERENCE.persistence.key) {
          themePayload = request.payload;
        }
        return of({ kind: 'completed' });
      },
    });

    expect(controller.hydrationWarning()).toEqual({
      code: 'appearance-preference-hydration-partial',
      recovery: 'reset-preferences',
    });
    expect(controller.axes.theme.value()).toBe(THEME_PREFERENCE.defaultValue);
    expect(
      Object.values(controller.axes).filter(
        (axis) => axis.state().kind !== 'recoverable-failure',
      ),
    ).toHaveLength(5);

    controller.recoverHydration();
    expect(controller.hydrationWarning()).toBeNull();
  });
});

function setup(
  adapter: PreferenceStorageAdapter,
): AppearanceSettingsController {
  const run = vi.fn(() => NEVER);
  TestBed.configureTestingModule({
    providers: [
      AppearanceSettingsController,
      provideAppearancePreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      {
        provide: AppearanceEffects,
        useValue: {
          resolved: signal(undefined).asReadonly(),
          run,
        } satisfies Pick<AppearanceEffects, 'resolved' | 'run'>,
      },
    ],
  });
  const controller = TestBed.inject(AppearanceSettingsController);
  expect(TestBed.inject(AppearancePreferences)).toBeDefined();
  expect(run).toHaveBeenCalledOnce();
  return controller;
}
