import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { TrnTabPanelComponent } from './trn-tab-panel.component';
import {
  TrnTabsComponent,
  type TrnTabOption,
  type TrnTabsPresentation,
  type TrnTabsVariant,
} from './trn-tabs.component';

/**
 * This wrapper adds no behaviour of its own, so what is worth pinning is the seam: that the
 * value reaches the brain directive through two levels of composition, and that the ARIA
 * wiring and keyboard handling the wrapper is thin *because of* are actually there. Both
 * failed once already — an input renamed on the way down bound nothing and threw NG0950 at
 * runtime, which is the failure this file is shaped around.
 *
 * The `<form>` is deliberate: both settings dialogs put tabs inside one, and a trigger that
 * defaulted to `type="submit"` would save the room on every tab switch.
 */
@Component({
  imports: [TrnTabsComponent, TrnTabPanelComponent],
  template: `
    <form (submit)="submits = submits + 1">
      <trn-tabs
        [tab]="tab()"
        [tabs]="tabs()"
        [variant]="variant()"
        [presentation]="presentation()"
        [orientation]="orientation()"
        (tabActivated)="activated.push($event)"
      >
        <trn-tab-panel value="general" data-t="panel-general">
          General body
        </trn-tab-panel>
        <trn-tab-panel value="access" data-t="panel-access">
          Access body
        </trn-tab-panel>
      </trn-tabs>
    </form>
  `,
})
class HostComponent {
  readonly tab = signal('general');
  readonly orientation = signal<'horizontal' | 'vertical'>('horizontal');
  readonly variant = signal<TrnTabsVariant>('neutral');
  readonly presentation = signal<TrnTabsPresentation>('pill');
  readonly tabs = signal<readonly TrnTabOption[]>([
    { value: 'general', label: 'General', testId: 'tab-general' },
    { value: 'access', label: 'Access', testId: 'tab-access' },
  ]);
  readonly activated: unknown[] = [];
  submits = 0;
}

async function build() {
  const { container, fixture } = await render(HostComponent);
  await fixture.whenStable();
  const trigger = (name: string) =>
    container.querySelector<HTMLButtonElement>(`[data-testid="tab-${name}"]`)!;
  /** The kit directive's element, not the `display: contents` host around it. */
  const panel = (name: string) =>
    container.querySelector<HTMLElement>(`[data-t="panel-${name}"] > div`)!;
  return {
    container,
    fixture,
    host: fixture.componentInstance,
    trigger,
    panel,
  };
}

describe('TrnTabsComponent', () => {
  it('separates semantic treatment from pill and line presentation', () => {
    expectTypeOf<TrnTabsVariant>().toEqualTypeOf<'neutral' | 'accent'>();
    expectTypeOf<TrnTabsPresentation>().toEqualTypeOf<'pill' | 'line'>();
  });

  it('shows the panel the active tab names, and hides the rest', async () => {
    const { panel } = await build();

    expect(panel('general').hidden).toBe(false);
    expect(panel('access').hidden).toBe(true);
    expect(panel('general').className).toContain('flex flex-col gap-3 pt-3');
  });

  it('switches panels when a trigger is pressed', async () => {
    const { trigger, panel, fixture } = await build();

    trigger('access').click();
    await fixture.whenStable();

    expect(panel('access').hidden).toBe(false);
    expect(panel('general').hidden).toBe(true);
  });

  it('reports the activated tab on an output nothing re-published', async () => {
    // `tabActivated` is BrnTabs's, re-published by HlmTabs and not listed on TrnTabs — the
    // one-level rule means it cannot be. If that re-publication ever stopped reaching this
    // far the binding would go quiet rather than fail to compile.
    const { trigger, host, fixture } = await build();

    trigger('access').click();
    await fixture.whenStable();

    expect(host.activated).toEqual(['access']);
  });

  it('does not submit the surrounding form when a tab is pressed', async () => {
    // BrnTabsTrigger's static type="button". A `<button>` in a form defaults to submit, so
    // without it every tab switch in the settings dialogs would save the room.
    const { trigger, host, fixture } = await build();

    expect(trigger('general').getAttribute('type')).toBe('button');
    trigger('access').click();
    await fixture.whenStable();

    expect(host.submits).toBe(0);
  });

  it('wires each trigger to its own panel for a screen reader', async () => {
    const { trigger, panel } = await build();

    expect(trigger('general').getAttribute('role')).toBe('tab');
    expect(trigger('general').getAttribute('aria-selected')).toBe('true');
    expect(trigger('access').getAttribute('aria-selected')).toBe('false');
    expect(trigger('general').getAttribute('aria-controls')).toBe(
      panel('general').id,
    );
    expect(panel('general').getAttribute('role')).toBe('tabpanel');
    expect(panel('general').getAttribute('aria-labelledby')).toBe(
      trigger('general').id,
    );
  });

  it('moves between tabs with the arrow keys', async () => {
    // BrnTabsList's FocusKeyManager, and the reason the triggers are rendered inside this
    // component rather than projected: its content query cannot see into a child view, so a
    // trigger one component deeper would leave the arrow keys doing nothing at all.
    const { container, trigger, panel, fixture } = await build();
    const list = container.querySelector('hlm-tabs-list')!;
    trigger('general').focus();

    // `keyCode` as well as `key`: CDK's ListKeyManager still switches on the legacy field,
    // and jsdom leaves it 0 for an event built from `key` alone — the arrow would be read as
    // no key at all and the test would fail against working code.
    const arrowRight = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
    });
    Object.defineProperty(arrowRight, 'keyCode', { get: () => 39 });
    list.dispatchEvent(arrowRight);
    await fixture.whenStable();

    expect(document.activeElement).toBe(trigger('access'));
    // activationMode defaults to 'automatic', so focus selects.
    expect(panel('access').hidden).toBe(false);
  });

  it('carries a bound orientation down two levels of composition', async () => {
    const { container, host, fixture } = await build();
    const tabs = container.querySelector('trn-tabs')!;

    expect(tabs.getAttribute('data-orientation')).toBe('horizontal');

    host.orientation.set('vertical');
    await fixture.whenStable();

    expect(tabs.getAttribute('data-orientation')).toBe('vertical');
  });

  it('disables the trigger a tab asks to disable', async () => {
    const { trigger, host, fixture } = await build();

    host.tabs.set([
      { value: 'general', label: 'General', testId: 'tab-general' },
      {
        value: 'access',
        label: 'Access',
        testId: 'tab-access',
        disabled: true,
      },
    ]);
    await fixture.whenStable();

    expect(trigger('access').hasAttribute('disabled')).toBe(true);
    expect(trigger('access').getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps exactly one trigger in the tab order', async () => {
    const { trigger } = await build();

    expect(trigger('general').tabIndex).toBe(0);
    expect(trigger('access').tabIndex).toBe(-1);
  });

  it('publishes canonical recipe state', async () => {
    const { container, host, fixture } = await build();
    const list = container.querySelector('hlm-tabs-list')!;

    host.variant.set('neutral');
    host.presentation.set('line');
    await fixture.whenStable();
    expect(list.getAttribute('data-trn-variant')).toBe('neutral');
    expect(list.getAttribute('data-trn-presentation')).toBe('line');

    host.variant.set('accent');
    host.presentation.set('pill');
    await fixture.whenStable();
    expect(list.getAttribute('data-trn-variant')).toBe('accent');
    expect(list.getAttribute('data-trn-presentation')).toBe('pill');
  });
});
