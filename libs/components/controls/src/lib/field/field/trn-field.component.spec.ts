import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnFieldLabelComponent } from '../field-label/trn-field-label.component';
import { TrnFieldComponent } from './trn-field.component';

@Component({
  imports: [TrnFieldComponent, TrnFieldLabelComponent],
  template: `
    <trn-field>
      <trn-field-label controlId="email" variant="eyebrow">
        Email
      </trn-field-label>
      <input id="email" type="email" />
    </trn-field>
  `,
})
class HostComponent {}

describe('TrnFieldComponent', () => {
  it('keeps the native label associated with the projected control', async () => {
    const { container } = await render(HostComponent);
    const label = container.querySelector('label');
    const control = container.querySelector('input');

    expect(label?.htmlFor).toBe(control?.id);
    expect(label?.textContent?.trim()).toBe('Email');
  });

  it('composes the public label wrapper and exposes the requested variant', async () => {
    const { container } = await render(HostComponent);
    const label = container.querySelector('label');

    expect(label?.getAttribute('data-slot')).toBe('label');
    expect(label?.getAttribute('data-variant')).toBe('eyebrow');
  });
});
