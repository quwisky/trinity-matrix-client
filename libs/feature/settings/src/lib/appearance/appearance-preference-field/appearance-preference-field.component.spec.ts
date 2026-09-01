import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AppearanceEffects,
  AppearancePreferences,
  provideAppearancePreferences,
  type ResolvedAppearance,
} from '@trinity/application/appearance';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { render } from '@trinity/testing';
import { NEVER, firstValueFrom, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppearanceSettingsController } from '../appearance-settings.controller';
import {
  AppearancePreferenceFieldComponent,
  type AppearancePreferenceField,
} from './appearance-preference-field.component';

const THEME_FIELD = {
  axis: 'theme',
  headingId: 'appearance-theme-heading',
  testId: 'theme-select',
  optionTestIdPrefix: 'theme',
} as const satisfies AppearancePreferenceField;

describe('AppearancePreferenceFieldComponent', () => {
  it('renders descriptor metadata and the committed value through stable hooks', async () => {
    const { container } = await renderField(() =>
      of({ kind: 'missing' as const }),
    );

    expect(container.querySelector('strong')?.textContent).toContain('Theme');
    expect(
      container.querySelector('[data-testid=theme-select]')?.textContent,
    ).toContain('Trinity');
    expect(
      container
        .querySelector('[data-testid=theme-select]')
        ?.getAttribute('aria-labelledby'),
    ).toBeNull();
    expect(
      container
        .querySelector('[role=combobox]')
        ?.getAttribute('aria-labelledby'),
    ).toBe(THEME_FIELD.headingId);
  });

  it('does not start a second hydration lifetime from the routed field', async () => {
    const read = vi.fn<PreferenceStorageAdapter['read']>(() => NEVER);
    const { container } = await renderField(read, false);

    expect(read).not.toHaveBeenCalled();
    expect(container.querySelector('[role=combobox][disabled]')).toBeNull();
  });
});

async function renderField(
  read: PreferenceStorageAdapter['read'],
  hydrate = true,
) {
  const resolved = signal<ResolvedAppearance | undefined>(undefined);
  const rendered = await render(AppearancePreferenceFieldComponent, {
    inputs: { field: THEME_FIELD },
    providers: [
      AppearanceSettingsController,
      provideAppearancePreferences(),
      {
        provide: PREFERENCE_STORAGE_ADAPTER,
        useValue: {
          read,
          write: () => of({ kind: 'completed' }),
        } satisfies PreferenceStorageAdapter,
      },
      {
        provide: AppearanceEffects,
        useValue: {
          resolved: resolved.asReadonly(),
          run: (): Observable<never> => NEVER,
        } satisfies Pick<AppearanceEffects, 'resolved' | 'run'>,
      },
    ],
  });
  if (hydrate) {
    await firstValueFrom(TestBed.inject(AppearancePreferences).hydrate());
    await rendered.fixture.whenStable();
  }
  return rendered;
}
