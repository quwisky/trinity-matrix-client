import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  CodeHighlightSettingsService,
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
  let maxHighlightLines: ReturnType<typeof signal<number>>;
  let setMaxHighlightLines: Mock;

  beforeEach(() => {
    codeScale = signal<CodeScale>('default');
    setCodeScale = vi.fn();
    codeLines = signal<CodeLineMode>('auto');
    setCodeLines = vi.fn();
    maxHighlightLines = signal(250);
    setMaxHighlightLines = vi.fn();
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
        MockProvider(CodeHighlightSettingsService, {
          maxHighlightLines,
          setMaxHighlightLines,
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
      container.querySelector('trn-select hlm-select-trigger')?.textContent,
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
    // And that the threshold survives all the way to the collapsed trigger — the surface
    // #168 was about. `auto` shares no substring with its label, so this needs no negative
    // half: reading anything other than the sentence means the id leaked through.
    expect(
      select?.querySelector('hlm-select-trigger')?.textContent?.trim(),
    ).toBe('Blocks over 5 lines');
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

  describe('the highlighting limit', () => {
    /** The number field, which — unlike the selects above — renders fully in jsdom. */
    const field = (container: HTMLElement) =>
      container.querySelector<HTMLInputElement>(
        '[data-testid=code-highlight-lines-input]',
      );

    const error = (container: HTMLElement) =>
      container
        .querySelector('[data-testid=code-highlight-lines-error]')
        ?.textContent?.trim() ?? null;

    it('shows the stored limit, named by its heading', async () => {
      maxHighlightLines.set(120);
      const { container } = await renderBlock();

      expect(field(container)?.value).toBe('120');
      const id = field(container)?.getAttribute('aria-labelledby');
      expect(container.querySelector(`#${id}`)?.textContent?.trim()).toBe(
        'Syntax highlighting',
      );
    });

    it('applies a valid limit only once the value settles', async () => {
      // Per keystroke would re-project every message in the open room three times on the
      // way to typing "250", so the commit hangs off `change`, not `input`.
      const { fixture, container } = await renderBlock();
      const cmp = fixture.componentInstance;

      cmp.onHighlightLinesInput('40');
      fixture.detectChanges();
      expect(setMaxHighlightLines).not.toHaveBeenCalled();
      expect(error(container)).toBeNull();

      cmp.commitHighlightLines();

      expect(setMaxHighlightLines).toHaveBeenCalledExactlyOnceWith(40);
    });

    it('takes 0 as the no-limit value rather than refusing it', async () => {
      const { fixture } = await renderBlock();
      const cmp = fixture.componentInstance;

      cmp.onHighlightLinesInput('0');
      cmp.commitHighlightLines();

      expect(setMaxHighlightLines).toHaveBeenCalledExactlyOnceWith(0);
    });

    it.each([
      ['empty', ''],
      ['blank', '  '],
      ['fractional', '12.5'],
      ['negative', '-1'],
      ['past the ceiling', '10001'],
      ['not a number', 'lots'],
    ])(
      'explains a limit that is %s, and applies nothing',
      async (_l, typed) => {
        const { fixture, container } = await renderBlock();
        const cmp = fixture.componentInstance;

        cmp.onHighlightLinesInput(typed);
        cmp.commitHighlightLines();
        fixture.detectChanges();

        expect(error(container)).not.toBeNull();
        expect(setMaxHighlightLines).not.toHaveBeenCalled();
      },
    );

    it('says what no limit costs once no limit is what is set', async () => {
      // The one setting here that can make the app slower, so the hint has to say so —
      // and only when it applies, or it reads as a warning against a default nobody chose.
      maxHighlightLines.set(0);
      const { container } = await renderBlock();

      expect(
        container.querySelector('#appearance-code-highlight-hint')?.textContent,
      ).toContain('hold the room up');
    });
  });
});
