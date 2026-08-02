import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type FormatAction } from '@trinity/util/matrix';
import { ComposerToolbarComponent } from './composer-toolbar.component';

async function renderToolbar(
  inputs: { narrow?: boolean; previewing?: boolean; disabled?: boolean } = {},
) {
  return render(ComposerToolbarComponent, { inputs });
}

const shown = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid^=format-]')].map((el) =>
    el.getAttribute('data-testid'),
  );

describe('ComposerToolbarComponent', () => {
  it('offers the common actions outright on a roomy layout', async () => {
    const { container } = await renderToolbar();

    expect(shown(container)).toEqual([
      'format-bold',
      'format-italic',
      'format-link',
      'format-code',
      'format-more',
    ]);
  });

  it('keeps only two actions outside the overflow on a narrow layout', async () => {
    // The composer competes with the on-screen keyboard there.
    const { container } = await renderToolbar({ narrow: true });

    expect(shown(container)).toEqual([
      'format-bold',
      'format-italic',
      'format-more',
    ]);
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

  it('puts everything not shown outright into the overflow', async () => {
    // The overflow is defined as the remainder, so no action can go missing or appear twice.
    const { fixture, container } = await renderToolbar({ narrow: true });
    container.querySelector<HTMLElement>('[data-testid=format-more]')?.click();
    await fixture.whenStable();

    const items = [
      ...document.querySelectorAll(
        '[hlmdropdownmenuitem][data-testid^=format-]',
      ),
    ].map((el) => el.getAttribute('data-testid'));

    expect(items).toEqual([
      'format-link',
      'format-code',
      'format-strike',
      'format-codeblock',
      'format-quote',
      'format-list',
      'format-tasklist',
    ]);
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

  it('disables every action while the composer is busy', async () => {
    const { container } = await renderToolbar({ disabled: true });

    for (const testid of ['format-bold', 'format-italic', 'format-more']) {
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

    for (const testid of ['format-bold', 'format-italic', 'format-more']) {
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
    // HlmTooltip like the rest of the composer's controls, rather than a native `title`,
    // which renders unstyled and on the browser's own delay.
    const { fixture, container } = await renderToolbar();

    const tooltips = fixture.debugElement.queryAll(By.directive(HlmTooltip));
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
      container.querySelector('[role=group]')?.getAttribute('aria-label'),
    ).toBe('Formatting');
  });

  afterEach(() => TestBed.resetTestingModule());
});
