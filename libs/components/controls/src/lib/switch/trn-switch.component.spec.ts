import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TrnSwitchComponent,
  type TrnSwitchSize,
  type TrnSwitchVariant,
} from './trn-switch.component';

@Component({
  imports: [TrnSwitchComponent],
  template: `
    <trn-switch
      [checked]="checked()"
      [disabled]="disabled()"
      variant="neutral"
      size="sm"
      aria-label="Send read receipts"
      aria-describedby="receipt-help"
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
  container.querySelector<HTMLInputElement>('[role="switch"]');

describe('TrnSwitchComponent', () => {
  it('limits the public recipe to implemented variants and sizes', () => {
    expectTypeOf<TrnSwitchVariant>().toEqualTypeOf<'neutral' | 'accent'>();
    expectTypeOf<'danger'>().not.toExtend<TrnSwitchVariant>();
    expectTypeOf<TrnSwitchSize>().toEqualTypeOf<'sm' | 'md'>();
    expectTypeOf<'lg'>().not.toExtend<TrnSwitchSize>();
  });

  it('reflects the bound state onto the rendered control', async () => {
    // Assert through the native input's ARIA state rather than a presentation class, because
    // ARIA is what both a screen reader and the e2e suite read
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
    expect(box(container)?.getAttribute('aria-describedby')).toBe(
      'receipt-help',
    );
  });

  it('maps the ordinal size and semantic tone without publishing Helm names', async () => {
    const { container } = await render(HostComponent);
    const host = container.querySelector('trn-switch');

    expect(host?.getAttribute('data-size')).toBe('sm');
    expect(host?.getAttribute('data-variant')).toBe('neutral');
    expect(container.querySelector('trn-switch > span')?.className).toContain(
      'h-3.5',
    );
  });

  it('emits when the control is operated, which is the whole job', async () => {
    // A settings toggle that does not emit does nothing at all, and the host's `last` signal
    // was already wired for this and going unread — the checkbox wrapper this was modelled on
    // has the same gap, and dropping `(checkedChange)` from either template leaves its suite
    // green. Driven through a real click rather than by calling the output, so the native
    // change event and public output stay wired together.
    const { container, fixture } = await render(HostComponent);
    expect(fixture.componentInstance.last()).toBeNull();

    box(container)?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.last()).toBe(true);
  });

  it('forwards disabled, which is what stops the click', async () => {
    // Native disabled is the load-bearing contract: it makes the click a no-op and is what
    // Playwright's actionability check waits on. The data marker keeps rendered-state
    // diagnostics explicit without publishing a vendor state name.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    const control = box(container);
    expect(control?.disabled).toBe(true);
    expect(control?.getAttribute('data-disabled')).toBe('true');
  });
});
