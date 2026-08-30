import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TrnTooltip } from '@trinity/components/generic-content';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type FormatAction } from '@trinity/util/matrix';
import { ComposerToolbarComponent } from './composer-toolbar.component';

async function renderToolbar(
  inputs: {
    previewing?: boolean;
    disabled?: boolean;
    pinned?: boolean;
    active?: FormatAction[];
  } = {},
) {
  return render(ComposerToolbarComponent, { inputs });
}

const shown = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid^=format-]')].map((el) =>
    el.getAttribute('data-testid'),
  );

describe('ComposerToolbarComponent', () => {
  it('offers all nine actions, with nothing behind a menu', async () => {
    // The overflow is gone with the always-on row that made it necessary. A bar that appears
    // when you select something can afford to show everything it does, and an action behind a
    // kebab is one nobody discovers.
    const { container } = await renderToolbar();

    expect(shown(container)).toEqual([
      'format-bold',
      'format-italic',
      'format-strike',
      'format-code',
      'format-codeblock',
      'format-quote',
      'format-link',
      'format-list',
      'format-tasklist',
      'format-pin',
    ]);
    expect(
      container.querySelector('[data-testid=format-more]'),
      'the overflow trigger must be gone, not merely empty',
    ).toBeNull();
  });

  it('divides the nine into three announced groups', async () => {
    // The rules are the only place the grouping is stated, so they are separators a screen
    // reader hears rather than lines drawn between buttons.
    const { container } = await renderToolbar();

    const rules = container.querySelectorAll('[trnSeparator]');
    expect(rules.length).toBe(2); // three groups, two rules
    for (const rule of rules) {
      expect(rule.getAttribute('role')).toBe('separator');
    }
  });

  it('is one tab stop for the nine, not nine', async () => {
    // The reason these are a toggle group at all: a nine-button bar that costs nine Tab
    // presses to cross is the thing `role="toolbar"` exists to avoid.
    const { container } = await renderToolbar();
    TestBed.tick();

    const actions = [
      ...container.querySelectorAll<HTMLElement>('[trnToggleGroupItem]'),
    ];
    expect(actions.length).toBe(9);
    expect(actions.filter((el) => el.tabIndex === 0).length).toBe(1);
  });

  it('presses the actions the selection already carries', async () => {
    // `aria-pressed` now means what it says: the composer derives this from the marks around
    // the selection, so Bold is pressed exactly when pressing it would REMOVE the bold.
    const { container } = await renderToolbar({ active: ['bold', 'quote'] });
    TestBed.tick();

    const pressed = (testid: string) =>
      container
        .querySelector<HTMLElement>(`[data-testid=${testid}]`)
        ?.getAttribute('aria-pressed');

    expect(pressed('format-bold')).toBe('true');
    expect(pressed('format-quote')).toBe('true');
    expect(pressed('format-italic')).toBe('false');
    expect(pressed('format-tasklist')).toBe('false');
  });

  it('leaves everything unpressed when the selection carries nothing', async () => {
    const { container } = await renderToolbar({ active: [] });
    TestBed.tick();

    const items = [
      ...container.querySelectorAll<HTMLElement>('[trnToggleGroupItem]'),
    ];
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(item.getAttribute('aria-pressed'), item.outerHTML).toBe('false');
    }
  });

  it('lets a re-derived value overrule the press that flipped the button', async () => {
    // `BrnToggleGroupItem` binds `(click)="toggle()"` on its own host, so an item flips
    // ITSELF the moment it is clicked, before anyone has looked at the text. That flip is
    // corrected by the NEXT value the composer derives — which is why `activeFormats` is a
    // `computed` returning a fresh array: a value re-set to the same reference would not
    // fire, and the stale flip would stand.
    //
    // The flip landing on the right answer most of the time is a coincidence worth not
    // relying on: pressing a toggle inverts it, and applying a format inverts the
    // formatting, so the two usually agree. They do not for `link` and `codeblock`, which
    // flip to pressed and are never reported — those are righted only by this overrule.
    const { fixture, container } = await renderToolbar({ active: [] });
    const link = container.querySelector<HTMLElement>(
      '[data-testid=format-link]',
    );

    link?.click();
    TestBed.tick();
    expect(link?.getAttribute('aria-pressed')).toBe('true'); // the kit's own doing

    fixture.componentRef.setInput('active', []); // a fresh array, as the computed gives
    TestBed.tick();

    expect(link?.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the pinned state on Aa, and emits when pressed', async () => {
    const { fixture, container } = await renderToolbar({ pinned: true });
    let toggled = 0;
    fixture.componentInstance.togglePinned.subscribe(() => toggled++);

    const pin = container.querySelector<HTMLElement>(
      '[data-testid=format-pin]',
    );
    expect(pin?.getAttribute('aria-pressed')).toBe('true');
    expect(pin?.getAttribute('aria-label')).toBe('Unpin formatting');

    pin?.click();
    expect(toggled).toBe(1);
  });

  it('emits the action a button stands for', async () => {
    const { fixture, container } = await renderToolbar();
    const emitted: FormatAction[] = [];
    fixture.componentInstance.format.subscribe((action) =>
      emitted.push(action),
    );

    container.querySelector<HTMLElement>('[data-testid=format-bold]')?.click();

    expect(emitted).toEqual(['bold']);
  });

  it('reports the preview state on the toggle, and emits when pressed', async () => {
    const { fixture, container } = await renderToolbar({ previewing: true });
    let toggled = 0;
    fixture.componentInstance.togglePreview.subscribe(() => toggled++);

    const button = container.querySelector<HTMLElement>(
      '[data-testid=composer-preview-toggle]',
    );
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    button?.click();
    expect(toggled).toBe(1);
  });

  it('disables every formatting action while the composer is busy', async () => {
    // The nine only. `format-pin` and the preview toggle are deliberately still live: they
    // change what the composer SHOWS, which is a fair thing to ask for mid-upload, where
    // wrapping text in a box you cannot type into is not.
    const { container } = await renderToolbar({ disabled: true });

    for (const testid of ['format-bold', 'format-italic', 'format-tasklist']) {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid=${testid}]`,
      );
      expect(button?.disabled, testid).toBe(true);
    }
    // The preview is still reachable — reading back what you wrote is not a mutation.
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid=composer-preview-toggle]',
      )?.disabled,
    ).toBe(false);
  });

  it('disables the formatting actions while previewing, but not the way back', async () => {
    // The textarea is hidden behind the preview, so a format button would rewrite text the
    // user cannot see, against a selection that is no longer on screen.
    const { container } = await renderToolbar({ previewing: true });

    for (const testid of ['format-bold', 'format-italic', 'format-tasklist']) {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid=${testid}]`,
      );
      expect(button?.disabled, testid).toBe(true);
    }
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid=composer-preview-toggle]',
      )?.disabled,
    ).toBe(false);
  });

  it('gives every button a design-system tooltip, not a browser one', async () => {
    // The buttons are icon-only, so the label has to be reachable on hover — and through
    // TrnTooltip like the rest of the composer's controls, rather than a native `title`,
    // which renders unstyled and on the browser's own delay.
    const { fixture, container } = await renderToolbar();

    const tooltips = fixture.debugElement.queryAll(By.directive(TrnTooltip));
    expect(tooltips.length).toBe(container.querySelectorAll('button').length);
    for (const button of container.querySelectorAll('button')) {
      expect(button.hasAttribute('title'), button.outerHTML).toBe(false);
    }
  });

  it('labels the preview toggle for the state it will move to', async () => {
    const { container } = await renderToolbar({ previewing: true });
    const toggle = container.querySelector(
      '[data-testid=composer-preview-toggle]',
    );

    expect(toggle?.getAttribute('aria-label')).toBe('Back to writing');
  });

  it('names every control for screen readers', async () => {
    const { container } = await renderToolbar();

    for (const button of container.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label'), button.outerHTML).toBeTruthy();
    }
    expect(
      container.querySelector('[role=toolbar]')?.getAttribute('aria-label'),
    ).toBe('Formatting');
  });

  afterEach(() => TestBed.resetTestingModule());
});
