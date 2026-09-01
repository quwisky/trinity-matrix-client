import { signal } from '@angular/core';
import {
  AppearanceEffects,
  provideAppearancePreferences,
} from '@trinity/application/appearance';
import {
  CODE_LINE_PRESENTATION_OPTIONS,
  CODE_SIZE_OPTIONS,
} from '@trinity/data-access/timeline';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppearanceSettingsController } from './appearance-settings.controller';
import { CodeAppearanceBlockComponent } from './code-appearance-block.component';

describe('CodeAppearanceBlockComponent', () => {
  it('renders both descriptor-owned controls with stable accessible hooks', async () => {
    const { container } = await renderBlock();

    expectLabel(container, 'code-scale-select', 'Code size');
    expectLabel(container, 'code-lines-select', 'Code line numbers');
  });

  it('shows committed code choices by label rather than by id', async () => {
    const { container, fixture } = await renderBlock();
    const appearance = fixture.debugElement.injector.get(
      AppearanceSettingsController,
    );

    appearance.update('codeSize', 'larger');
    appearance.update('codeLinePresentation', 'always');
    fixture.detectChanges();

    expect(triggerText(container, 'code-scale-select')).toContain('Larger');
    expect(triggerText(container, 'code-lines-select')).toContain('Always');
  });

  it('keeps the capability-owned option order and line threshold', async () => {
    const { fixture } = await renderBlock();
    const axes = fixture.debugElement.injector.get(
      AppearanceSettingsController,
    ).axes;

    expect(axes.codeSize.editor.options).toEqual(
      CODE_SIZE_OPTIONS.map(({ id, label }) => ({ value: id, label })),
    );
    expect(axes.codeLinePresentation.editor.options).toEqual(
      CODE_LINE_PRESENTATION_OPTIONS.map(({ id, label }) => ({
        value: id,
        label,
      })),
    );
    expect(axes.codeLinePresentation.editor.options[1]?.label).toBe(
      'Blocks over 5 lines',
    );
  });
});

function renderBlock() {
  const adapter: PreferenceStorageAdapter = {
    read: () => of({ kind: 'missing' }),
    write: () => of({ kind: 'completed' }),
  };
  return render(CodeAppearanceBlockComponent, {
    providers: [
      AppearanceSettingsController,
      provideAppearancePreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      MockProvider(AppearanceEffects, {
        resolved: signal(undefined).asReadonly(),
        run: () => NEVER,
      }),
    ],
  });
}

function expectLabel(container: Element, testId: string, label: string): void {
  const select = container.querySelector(
    `[data-testid=${testId}] [role=combobox]`,
  );
  const headingId = select?.getAttribute('aria-labelledby');
  expect(container.querySelector(`#${headingId}`)?.textContent?.trim()).toBe(
    label,
  );
}

function triggerText(container: Element, testId: string): string {
  return (
    container.querySelector(`[data-testid=${testId}] hlm-select-trigger`)
      ?.textContent ?? ''
  );
}
