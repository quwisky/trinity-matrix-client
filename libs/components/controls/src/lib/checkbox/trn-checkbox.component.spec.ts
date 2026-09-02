import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TrnCheckboxComponent,
  type TrnCheckboxSize,
  type TrnCheckboxVariant,
} from './trn-checkbox.component';

@Component({
  imports: [TrnCheckboxComponent],
  template: `
    <trn-checkbox
      [checked]="checked()"
      [disabled]="disabled()"
      [indeterminate]="indeterminate()"
      [invalid]="invalid()"
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
  readonly indeterminate = signal(false);
  readonly invalid = signal(false);
  readonly last = signal<boolean | null>(null);
}

const box = (container: Element) =>
  container.querySelector<HTMLInputElement>('[role="checkbox"]');

describe('TrnCheckboxComponent', () => {
  it('limits the public recipe to implemented variants and sizes', () => {
    expectTypeOf<TrnCheckboxVariant>().toEqualTypeOf<'neutral' | 'accent'>();
    expectTypeOf<'danger'>().not.toExtend<TrnCheckboxVariant>();
    expectTypeOf<TrnCheckboxSize>().toEqualTypeOf<'sm' | 'md'>();
    expectTypeOf<'lg'>().not.toExtend<TrnCheckboxSize>();
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

  it('maps size, tone, indeterminate and invalid state onto the real control', async () => {
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.indeterminate.set(true);
    fixture.componentInstance.invalid.set(true);
    await fixture.whenStable();

    const host = container.querySelector('trn-checkbox');
    expect(host?.getAttribute('data-size')).toBe('sm');
    expect(host?.getAttribute('data-variant')).toBe('neutral');
    expect(host?.getAttribute('data-invalid')).toBe('true');
    expect(box(container)?.getAttribute('aria-checked')).toBe('mixed');
    expect(box(container)?.getAttribute('aria-invalid')).toBe('true');
  });

  it('emits when the control is operated, which is the whole job', async () => {
    // The host has wired `last` since this spec was written and nothing ever read it, so
    // deleting `(checkedChange)` from the template left the suite green — a checkbox that
    // does not emit does nothing at all. Found while mirroring this file for `trn-switch`,
    // where the same gap would have shipped again.
    //
    // Driven through a real click rather than by calling the output, so the native change
    // event and public output stay wired together.
    const { container, fixture } = await render(HostComponent);
    expect(fixture.componentInstance.last()).toBeNull();

    box(container)?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.last()).toBe(true);
  });

  it('forwards disabled, which is what stops the click', async () => {
    // Native disabled is the load-bearing contract: it makes the click a no-op and is what
    // Playwright's actionability check waits on.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    const host = container.querySelector('trn-checkbox');
    expect(host?.getAttribute('data-size')).toBe('sm');
    expect(box(container)?.disabled).toBe(true);
  });
});
