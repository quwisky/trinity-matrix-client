import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnCheckboxComponent } from './trn-checkbox.component';

@Component({
  imports: [TrnCheckboxComponent],
  template: `
    <trn-checkbox
      [checked]="checked()"
      [disabled]="disabled()"
      aria-label="Send read receipts"
      (checkedChange)="last.set($event)"
    />
  `,
})
class HostComponent {
  readonly checked = signal(false);
  readonly disabled = signal(false);
  readonly last = signal<boolean | null>(null);
}

const box = (container: Element) =>
  container.querySelector('[role="checkbox"]');

describe('TrnCheckboxComponent', () => {
  it('reflects the bound state onto the rendered control', async () => {
    // The defect control: `role="checkbox"` and `aria-checked` come from the kit component
    // this wraps, so they exist only if the composition happened. Asserted through ARIA
    // rather than a class, because ARIA is what both a screen reader and the e2e suite read
    // (`notification-sound.spec.mts` asserts exactly this attribute).
    const { container, fixture } = await render(HostComponent);

    expect(box(container)?.getAttribute('aria-checked')).toBe('false');

    fixture.componentInstance.checked.set(true);
    fixture.detectChanges();

    expect(box(container)?.getAttribute('aria-checked')).toBe('true');
  });

  it('names itself when there is no visible label to do it', async () => {
    const { container } = await render(HostComponent);

    expect(box(container)?.getAttribute('aria-label')).toBe(
      'Send read receipts',
    );
  });

  it('forwards disabled, which is what stops the click', async () => {
    // Expressed as `data-disabled` on the host and a native `disabled` on the inner
    // control, not `aria-disabled` — asserted against what the kit actually renders rather
    // than what a wrapper author would assume. The native property is the load-bearing
    // half: it is what makes the click a no-op and what Playwright's actionability waits on.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    const host = container.querySelector('trn-checkbox > hlm-checkbox');
    expect(host?.hasAttribute('data-disabled')).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[role="checkbox"]')?.disabled,
    ).toBe(true);
  });
});
