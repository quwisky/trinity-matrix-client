import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from './trn-select.component';

const OPTIONS: readonly TrnSelectOption<string>[] = [
  { value: 'recent', label: 'Recent activity', testId: 'space-order-recent' },
  {
    value: 'space',
    label: 'Space order',
    description: 'The order the space itself defines',
    testId: 'space-order-space',
  },
];

@Component({
  imports: [TrnSelectComponent],
  template: `
    <h2 id="space-order-heading">Room order</h2>
    <trn-select
      data-testid="space-order-select"
      aria-labelledby="space-order-heading"
      placeholder="Select an order"
      triggerClass="w-full"
      [options]="options"
      [value]="value()"
      (valueChange)="value.set($event)"
    />
  `,
})
class HostComponent {
  readonly options = OPTIONS;
  readonly value = signal('recent');
}

const trigger = (container: Element) =>
  container.querySelector('hlm-select-trigger');

describe('TrnSelectComponent', () => {
  it('shows the chosen option’s label in the trigger, not its stored value', async () => {
    // This is what replaced `itemToString`. All four call sites that bound it passed the
    // same lookup — find the option, return its label — which a component holding the
    // options can do itself. The defect control: without it the trigger reads "recent".
    const { container } = await render(HostComponent);

    expect(trigger(container)?.textContent).toContain('Recent activity');
    expect(trigger(container)?.textContent).not.toContain('recent');
  });

  it('puts the trigger class where the width has to land', async () => {
    // `class` and `triggerClass` cannot be one input: every call site sets `block` on the
    // select and `w-full` on the TRIGGER, and the kit's trigger is `w-fit`. Folding them
    // together would shrink every settings select to the width of its own text.
    const { container } = await render(HostComponent);

    expect(container.querySelector('button')?.className).toContain('w-full');
  });

  it('keeps the shared coarse-pointer target floor on the trigger', async () => {
    const { container } = await render(HostComponent);
    const buttonClass = container.querySelector('button')?.className;

    expect(buttonClass).toContain(
      'min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))]',
    );
    expect(buttonClass).toContain('text-[var(--trinity-text-bright)]');
  });

  it('forwards its accessible name to the actual combobox trigger', async () => {
    const { container } = await render(HostComponent);
    const button = container.querySelector('[role=combobox]');

    expect(button?.getAttribute('aria-labelledby')).toBe('space-order-heading');
    expect(
      container.querySelector('trn-select')?.hasAttribute('aria-labelledby'),
    ).toBe(false);
  });

  it('falls back to the raw value when no option matches it', async () => {
    // A stored preference for an option we no longer ship must not blank the trigger.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.value.set('a-z');
    fixture.detectChanges();

    expect(trigger(container)?.textContent).toContain('a-z');
  });

  it('keeps the placeholder for when nothing is chosen', async () => {
    // Asserted on the rendered TEXT, not on the presence of `[data-slot="select-value"]`:
    // the kit emits that attribute whenever a placeholder is set at all, whatever the value,
    // so the older form of this test passed for every input it could be given — including
    // the defect the test above exists for.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.value.set('');
    fixture.detectChanges();

    expect(trigger(container)?.textContent).toBe('Select an order');
  });

  it('is a block on its own, without the call site supplying it', async () => {
    // The kit's trigger is `w-fit`, so an inline host collapses the control to its content
    // width. Every call site used to write `class="block"` to avoid that — a rule each
    // consumer had to know, and the first to forget it got a silently narrow select. The
    // component owns it now, and this host deliberately does NOT pass the class, so the
    // assertion fails if the style is dropped rather than passing on the caller's copy.
    //
    // Assertable because it is a component `styles:` declaration: jsdom loads no
    // stylesheet, but it does apply component styles.
    const { container } = await render(HostComponent);
    const host = container.querySelector('trn-select') as HTMLElement;

    expect(getComputedStyle(host).display).toBe('block');
  });

  it('is a Signal Forms control, so `[formField]` drives it', async () => {
    // The contract is one thing — `value` must be a `model()` kept in sync with the bound
    // field — and satisfying it is what lets the three room/space settings selects keep their
    // schema gating instead of hand-bridging `[value]`/`(valueChange)` and a `[disabled]`
    // that would be NG8022 beside a `[formField]`.
    //
    // Asserted structurally rather than by wiring a whole form: what breaks the contract is
    // `value` going back to an `input()`, and `set` is the method an input does not have.
    const { fixture } = await render(TrnSelectComponent<string>, {
      inputs: { options: [{ value: 'a', label: 'A' }] },
    });
    const cmp = fixture.componentInstance;

    expect(typeof (cmp.value as unknown as { set?: unknown }).set).toBe(
      'function',
    );
    cmp.value.set('a');
    expect(cmp.value()).toBe('a');
  });

  it('takes disabled, which is how the schema gate reaches the control', async () => {
    const { fixture, container } = await render(TrnSelectComponent<string>, {
      inputs: { options: [{ value: 'a', label: 'A' }] },
    });
    expect(container.querySelector('[disabled]')).toBeNull();

    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    expect(container.querySelector('[disabled]')).not.toBeNull();
  });
});
