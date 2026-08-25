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
      (checkedChange)="last.set($event)"
    />
  `,
})
class HostComponent {
  readonly checked = signal(false);
  readonly disabled = signal(false);
  readonly last = signal<boolean | null>(null);
}

const box = (container: Element) => container.querySelector('[role="switch"]');

describe('TrnSwitchComponent', () => {
  it('reflects the bound state onto the rendered control', async () => {
    // The defect control: `role="switch"` and `aria-checked` come from the kit component
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

  it('emits when the control is operated, which is the whole job', async () => {
    // A settings toggle that does not emit does nothing at all, and the host's `last` signal
    // was already wired for this and going unread — the checkbox wrapper this was modelled on
    // has the same gap, and dropping `(checkedChange)` from either template leaves its suite
    // green. Driven through a real click rather than by calling the output, so the kit's own
    // event plumbing is part of what is under test.
    const { container, fixture } = await render(HostComponent);
    expect(fixture.componentInstance.last()).toBeNull();

    (box(container) as HTMLElement | null)?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.last()).toBe(true);
  });

  it('forwards disabled, which is what stops the click', async () => {
    // Asserted against what the kit ACTUALLY renders, not against what the checkbox wrapper
    // renders: `hlm-checkbox` carries `data-disabled` on its own element, `hlm-switch` does
    // not — it puts it on the inner `brn-switch` and on the button. Copying the checkbox's
    // assertion across gave a green-looking test that failed for the right reason.
    //
    // The native `disabled` is the load-bearing half either way: it is what makes the click a
    // no-op and what Playwright's actionability check waits on. `data-disabled` is what the
    // kit's own `data-[disabled=true]:` classes key off, so both are worth pinning.
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();

    const control = box(container) as HTMLButtonElement | null;
    expect(control?.disabled).toBe(true);
    expect(control?.getAttribute('data-disabled')).toBe('true');
  });
});
