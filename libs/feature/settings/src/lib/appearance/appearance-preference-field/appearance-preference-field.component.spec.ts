import { signal } from '@angular/core';
import {
  AppearanceEffects,
  provideAppearancePreferences,
  type ResolvedAppearance,
} from '@trinity/application/appearance';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { render } from '@trinity/testing';
import { NEVER, of, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppearanceSettingsController } from '../appearance-settings.controller';
import {
  AppearancePreferenceFieldComponent,
  type AppearancePreferenceField,
} from './appearance-preference-field.component';

const THEME_FIELD = {
  axis: 'theme',
  headingId: 'appearance-theme-heading',
  testId: 'palette-select',
  optionTestIdPrefix: 'palette',
} as const satisfies AppearancePreferenceField;

describe('AppearancePreferenceFieldComponent', () => {
  it('renders descriptor metadata and the committed value through stable hooks', async () => {
    const { container } = await renderField(() =>
      of({ kind: 'missing' as const }),
    );

    expect(container.querySelector('strong')?.textContent).toContain('Theme');
    expect(
      container.querySelector('[data-testid=palette-select]')?.textContent,
    ).toContain('Trinity');
    expect(
      container
        .querySelector('[data-testid=palette-select]')
        ?.getAttribute('aria-labelledby'),
    ).toBeNull();
    expect(
      container
        .querySelector('[role=combobox]')
        ?.getAttribute('aria-labelledby'),
    ).toBe(THEME_FIELD.headingId);
  });

  it('disables the control until hydration settles', async () => {
    const { container } = await renderField(() => NEVER);

    expect(container.querySelector('[role=combobox][disabled]')).not.toBeNull();
  });
});

function renderField(read: PreferenceStorageAdapter['read']) {
  const resolved = signal<ResolvedAppearance | undefined>(undefined);
  return render(AppearancePreferenceFieldComponent, {
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
}
