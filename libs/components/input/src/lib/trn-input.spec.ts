import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnInput } from './trn-input';

@Component({
  imports: [TrnInput],
  template: `
    <input trnInput id="gw" aria-describedby="gw-help" />
    <p id="gw-help">Where push notifications are sent.</p>
  `,
})
class HostComponent {}

describe('TrnInput', () => {
  it('keeps the consumer’s aria-describedby, which the kit silently wiped once', async () => {
    // #153: BrnFieldControlDescribedBy owns [attr.aria-describedby] as a host binding, so a
    // consumer's value is computed as null and removed unless the composed entry publishes
    // the input. `hostDirectives` forwarding does not CHAIN, so a wrapper cannot re-publish
    // the kit's — it has to own the attribute itself. This is the assertion that proves it.
    const { container } = await render(HostComponent);

    expect(
      container.querySelector('input')?.getAttribute('aria-describedby'),
    ).toBe('gw-help');
  });

  it('stays on the native element it was applied to', async () => {
    const { container } = await render(HostComponent);
    const el = container.querySelector('input');

    expect(el?.tagName).toBe('INPUT');
    expect(el?.getAttribute('data-slot')).toBe('input');
  });
});
