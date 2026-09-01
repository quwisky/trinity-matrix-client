import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnSpinnerComponent } from './trn-spinner.component';

// Driven through a host rather than `render(..., { inputs })`: `aria-label` is an ALIASED
// input, and an alias cannot be named in that object — the typecheck gate rejects it. A
// template binding is also how every call site actually addresses it.
@Component({
  imports: [TrnSpinnerComponent],
  template: `<trn-spinner aria-label="Verifying" size="lg" variant="accent" />`,
})
class LabelledHostComponent {}

@Component({
  imports: [TrnSpinnerComponent],
  template: `<trn-spinner />`,
})
class BareHostComponent {}

const spinner = (container: Element) =>
  container.querySelector('trn-spinner > hlm-spinner');

describe('TrnSpinnerComponent', () => {
  it('renders a labelled status region', async () => {
    // The defect control: `role` and `aria-label` come from the kit component this wraps,
    // so they are present only if the composition happened.
    const { container } = await render(LabelledHostComponent);

    expect(spinner(container)?.getAttribute('role')).toBe('status');
    expect(spinner(container)?.getAttribute('aria-label')).toBe('Verifying');
  });

  it('defaults its label rather than announcing an unnamed status', async () => {
    const { container } = await render(BareHostComponent);

    expect(spinner(container)?.getAttribute('aria-label')).toBe('Loading');
  });

  it('publishes only the applicable size and semantic ink', async () => {
    const { container } = await render(LabelledHostComponent);
    const host = container.querySelector('trn-spinner');

    expect(host?.getAttribute('data-size')).toBe('lg');
    expect(host?.getAttribute('data-variant')).toBe('accent');
  });

  it('keeps appearance off the host class contract', async () => {
    // The layered stylesheet owns the host box and the inner recipe owns appearance. jsdom
    // cannot evaluate @layer; Storybook verifies the dimensions in a real browser. Keeping
    // this host free of recipe classes reserves consumer classes for external layout.
    const { container } = await render(BareHostComponent);
    const host = container.querySelector('trn-spinner') as HTMLElement;

    expect([...host.classList]).toEqual([]);
  });
});
