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
    <trn-select
      class="block"
      data-testid="space-order-select"
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

  it('falls back to the raw value when no option matches it', async () => {
    // A stored preference for an option we no longer ship must not blank the trigger.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.value.set('a-z');
    fixture.detectChanges();

    expect(trigger(container)?.textContent).toContain('a-z');
  });

  it('keeps the placeholder for when nothing is chosen', async () => {
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.value.set('');
    fixture.detectChanges();

    expect(
      container.querySelector('[data-slot="select-value"]'),
    ).not.toBeNull();
  });
});
