import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  ThemeService,
  TRINITY_CODE_LINE_MODES,
  TRINITY_CODE_SCALES,
  type CodeLineMode,
  type CodeScale,
} from '@trinity/platform-native';
import { CodeAppearanceBlockComponent } from './code-appearance-block.component';

describe('CodeAppearanceBlockComponent', () => {
  let codeScale: ReturnType<typeof signal<CodeScale>>;
  let setCodeScale: Mock;
  let codeLines: ReturnType<typeof signal<CodeLineMode>>;
  let setCodeLines: Mock;

  beforeEach(() => {
    codeScale = signal<CodeScale>('default');
    setCodeScale = vi.fn();
    codeLines = signal<CodeLineMode>('auto');
    setCodeLines = vi.fn();
  });

  function renderBlock() {
    return render(CodeAppearanceBlockComponent, {
      providers: [
        MockProvider(ThemeService, {
          codeScale,
          codeScales: TRINITY_CODE_SCALES,
          setCodeScale,
          codeLines,
          codeLineModes: TRINITY_CODE_LINE_MODES,
          setCodeLines,
        }),
      ],
    });
  }

  it('renders the control with an accessible name', async () => {
    const { container } = await renderBlock();

    const select = container.querySelector('[data-testid=code-scale-select]');
    expect(select).not.toBeNull();
    const id = select?.getAttribute('aria-labelledby');
    expect(container.querySelector(`#${id}`)?.textContent?.trim()).toBe(
      'Code size',
    );
  });

  it('shows the stored size by its label, not its id', async () => {
    // `trn-select` renders the collapsed trigger from the bound VALUE, so without
    // `itemToString` this reads "larger". The option list itself lives in a CDK overlay that
    // only exists once opened, which jsdom cannot do — hence the trigger, not the options.
    codeScale.set('larger');
    const { container } = await renderBlock();

    expect(
      container.querySelector('trn-select-trigger')?.textContent,
    ).toContain('Larger');
  });

  it('applies a registered size and ignores anything else', async () => {
    const { fixture } = await renderBlock();
    const cmp = fixture.componentInstance;

    cmp.onCodeScaleChange('smaller');
    expect(setCodeScale).toHaveBeenCalledWith('smaller');

    // `valueChange` is typed `string | null | undefined`, so the guard is what stops an
    // unregistered id reaching the service and being persisted.
    cmp.onCodeScaleChange('gigantic');
    cmp.onCodeScaleChange(null);
    cmp.onCodeScaleChange(undefined);
    expect(setCodeScale).toHaveBeenCalledTimes(1);
  });

  it('names the threshold in the line-number options rather than hiding it', async () => {
    // The default is neither on nor off, which is why this is a select and not a checkbox.
    // The middle label states the rule, so the behaviour is legible without the docs — keep
    // it in step with LINE_NUMBER_THRESHOLD in message-view.ts.
    expect(TRINITY_CODE_LINE_MODES.map((m) => m.id)).toEqual([
      'off',
      'auto',
      'always',
    ]);
    expect(TRINITY_CODE_LINE_MODES[1]).toMatchObject({
      id: 'auto',
      label: 'Blocks over 5 lines',
    });

    const { container } = await renderBlock();
    const select = container.querySelector('[data-testid=code-lines-select]');
    const id = select?.getAttribute('aria-labelledby');
    expect(container.querySelector(`#${id}`)?.textContent?.trim()).toBe(
      'Line numbers',
    );
  });

  it('applies a registered line-number mode and ignores anything else', async () => {
    const { fixture } = await renderBlock();
    const cmp = fixture.componentInstance;

    cmp.onCodeLinesChange('always');
    expect(setCodeLines).toHaveBeenCalledWith('always');

    cmp.onCodeLinesChange('sometimes');
    cmp.onCodeLinesChange(null);
    expect(setCodeLines).toHaveBeenCalledTimes(1);
  });

  it('lists the three sizes smallest first', () => {
    // The registry only — deliberately NOT rendered. The option list lives in a CDK overlay
    // that only exists once opened, which jsdom cannot do, so a render() here would assert
    // nothing about the picker; the earlier version of this test injected the mock and
    // compared its own input to itself. That the template iterates this registry is covered
    // in e2e, where the dropdown can actually be opened.
    expect(TRINITY_CODE_SCALES.map((scale) => scale.id)).toEqual([
      'smaller',
      'default',
      'larger',
    ]);
  });
});
