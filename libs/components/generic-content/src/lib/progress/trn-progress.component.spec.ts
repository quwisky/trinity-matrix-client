import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnProgressComponent } from './trn-progress.component';

// A host, not `render(..., { inputs })`: `aria-label` is aliased and cannot be named there.
@Component({
  imports: [TrnProgressComponent],
  template: `<trn-progress
    [value]="value()"
    variant="success"
    size="md"
    aria-label="Uploading attachment"
  />`,
})
class HostComponent {
  readonly value = signal<number | null>(42);
}

const bar = (container: Element) =>
  container.querySelector('[role="progressbar"]');

describe('TrnProgressComponent', () => {
  it('collapses the kit’s two elements into one, and still reports a value', async () => {
    // The point of the collapse: the call site no longer has to know that an indicator
    // child exists, injects its parent, and must sit exactly there.
    const { container } = await render(HostComponent);

    expect(bar(container)?.getAttribute('aria-valuenow')).toBe('42');
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(1);

    // The indicator is the part that is actually visible, and it has to be asserted
    // separately: `role` and `aria-valuenow` come from the HOST, so without this the
    // indicator could disappear entirely — a bar reporting 42% and drawing nothing — and
    // every other assertion here would stay green. Verified by deleting it.
    expect(
      container.querySelector('[data-slot="progress-indicator"]'),
    ).not.toBeNull();
  });

  it('treats null as indeterminate, which is what an upload with no total needs', async () => {
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.value.set(null);
    fixture.detectChanges();

    // An indeterminate bar publishes no value at all — a 0 would read as "stalled at 0%".
    expect(bar(container)?.hasAttribute('aria-valuenow')).toBe(false);
  });

  it('names what is progressing', async () => {
    const { container } = await render(HostComponent);

    expect(
      container.querySelector('[aria-label="Uploading attachment"]'),
    ).not.toBeNull();
  });

  it('publishes semantic recipe and behavior state independently', async () => {
    const { container, fixture } = await render(HostComponent);
    const host = container.querySelector('trn-progress');

    expect(host?.getAttribute('data-variant')).toBe('success');
    expect(host?.getAttribute('data-size')).toBe('md');
    expect(host?.getAttribute('data-state')).toBe('determinate');

    fixture.componentInstance.value.set(null);
    fixture.detectChanges();
    expect(host?.getAttribute('data-state')).toBe('indeterminate');
    expect(host?.getAttribute('data-variant')).toBe('success');
  });
});
