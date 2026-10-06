import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnSwitchComponent } from './trn-switch.component';

@Component({
  imports: [TrnSwitchComponent],
  template: `
    <trn-switch
      [checked]="checked()"
      [disabled]="disabled()"
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

@Component({
  imports: [TrnSwitchComponent],
  template: `
    <label for="receipts-switch">Receipts</label>
    <trn-switch inputId="receipts-switch" (checkedChange)="last.set($event)" />
  `,
})
class LabelledHostComponent {
  readonly last = signal<boolean | null>(null);
}

describe('TrnSwitchComponent', () => {
  it('puts inputId on the native control, so a label for it operates the switch', async () => {
    const { container, fixture } = await render(LabelledHostComponent);
    expect(box(container)?.id).toBe('receipts-switch');

    container.querySelector('label')!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.last()).toBe(true);
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

  it('reverts in place, keeping focus, when the parent declines the change', async () => {
    const { container, fixture } = await render(HostComponent);
    const input = box(container);
    input?.focus();
    input?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.last()).toBe(true);
    expect(box(container)).toBe(input);
    expect(input?.checked).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('follows the parent when it accepts the change', async () => {
    const { container, fixture } = await render(HostComponent);
    box(container)?.click();
    fixture.componentInstance.checked.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(box(container)?.checked).toBe(true);
    expect(box(container)?.getAttribute('aria-checked')).toBe('true');
  });
});
