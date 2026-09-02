import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnLabel } from './trn-label';

@Component({
  imports: [TrnLabel],
  template: `<label trnLabel for="pw" emphasis="strong" invalid
    >Password</label
  >`,
})
class HostComponent {}

describe('TrnLabel', () => {
  it('leaves the host a native label, with its association intact', async () => {
    const { container } = await render(HostComponent);
    const label = container.querySelector('label');

    // Rule 3/4: an element wrapper would have broken both of these, and they are what makes
    // a label a label — the `for`/`id` pairing is native, not something a directive grants.
    expect(label?.tagName).toBe('LABEL');
    expect(label?.getAttribute('for')).toBe('pw');
  });

  it('applies the composed kit directive', async () => {
    // The defect control for this step. `data-slot` comes from the kit directive this
    // wrapper composes through `hostDirectives`, so it is present only if the composition
    // actually happened — delete the wrapper from the template and this fails, where a
    // bare `expect(label).toBeTruthy()` would not.
    const { container } = await render(HostComponent);

    expect(container.querySelector('label')?.getAttribute('data-slot')).toBe(
      'label',
    );
  });

  it('keeps emphasis separate from validation state', async () => {
    const { container } = await render(HostComponent);
    const label = container.querySelector('label');

    expect(label?.getAttribute('data-emphasis')).toBe('strong');
    expect(label?.getAttribute('data-invalid')).toBe('true');
    expect(label?.className).toContain('font-bold');
    expect(label?.className).toContain('text-danger');
  });
});
