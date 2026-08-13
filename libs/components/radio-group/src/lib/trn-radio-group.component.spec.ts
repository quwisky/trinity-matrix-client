import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from './trn-radio-group.component';

const OPTIONS: readonly TrnRadioOption<string>[] = [
  { value: 'system', label: 'Use system setting', testId: 'theme-system' },
  { value: 'light', label: 'Light', testId: 'theme-light' },
  { value: 'dark', label: 'Dark', testId: 'theme-dark' },
];

@Component({
  imports: [TrnRadioGroupComponent],
  template: `
    <h2 id="mode-heading">Appearance</h2>
    <trn-radio-group
      aria-labelledby="mode-heading"
      [options]="options"
      [value]="value()"
      (valueChange)="value.set($event)"
    />
  `,
})
class HostComponent {
  readonly options = OPTIONS;
  readonly value = signal('system');
}

describe('TrnRadioGroupComponent', () => {
  it('renders one label per option, and wraps the radio in it', async () => {
    const { container } = await render(HostComponent);
    const labels = container.querySelectorAll('label');

    expect(labels.length).toBe(3);
    // The label WRAPPING the radio is the point, not decoration. It is what makes the text
    // a click target — e2e clicks `getByTestId('theme-dark')`, which is this label, not the
    // radio — and the kit's radio resolves `closest('label')` in a constructor effect to
    // stamp its disabled state. A wrapper that emitted them as siblings would break both,
    // silently.
    expect(labels[2].getAttribute('data-testid')).toBe('theme-dark');
    expect(labels[2].textContent?.trim()).toBe('Dark');
    expect(labels[2].querySelector('hlm-radio')).not.toBeNull();
  });

  it('points the group at its heading, and only the group', async () => {
    // Rule 7: `aria-labelledby` has to reach the element that actually carries the role.
    // Left on the wrapper host it would name an element with no role at all, and the
    // radiogroup would stay anonymous — which is how it behaves today at the call site.
    const { container } = await render(HostComponent);

    expect(
      container
        .querySelector('[role="radiogroup"]')
        ?.getAttribute('aria-labelledby'),
    ).toBe('mode-heading');
    expect(
      container
        .querySelector('trn-radio-group')
        ?.hasAttribute('aria-labelledby'),
    ).toBe(false);
  });

  it('reports the chosen value', async () => {
    const { container, fixture } = await render(HostComponent);
    container.querySelectorAll('label')[1].click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('light');
  });
});
