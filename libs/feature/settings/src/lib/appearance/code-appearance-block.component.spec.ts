import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  let setCodeScale: ReturnType<typeof vi.fn>;
  let codeLines: ReturnType<typeof signal<CodeLineMode>>;
  let setCodeLines: ReturnType<typeof vi.fn>;

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
    // `hlm-select` renders the collapsed trigger from the bound VALUE, so without
    // `itemToString` this reads "larger". The option list itself lives in a CDK overlay that
    // only exists once opened, which jsdom cannot do — hence the trigger, not the options.
    codeScale.set('larger');
    const { container } = await renderBlock();

    expect(
      container.querySelector('hlm-select-trigger')?.textContent,
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

  it('offers every registered scale as an option', async () => {
    await renderBlock();

    // Not the rendered options — those need the overlay. The registry is what the template
    // iterates, so this pins that a newly registered scale reaches the picker.
    expect(TestBed.inject(ThemeService).codeScales.map((s) => s.id)).toEqual([
      'smaller',
      'default',
      'larger',
    ]);
  });
});
