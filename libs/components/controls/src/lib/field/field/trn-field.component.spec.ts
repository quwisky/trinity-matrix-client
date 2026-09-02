import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnFieldLabelComponent } from '../field-label/trn-field-label.component';
import { TrnInput } from '../../input/trn-input';
import { TrnFieldComponent } from './trn-field.component';

@Component({
  imports: [TrnFieldComponent, TrnFieldLabelComponent, TrnInput],
  template: `
    <trn-field invalid>
      <trn-field-label controlId="email" emphasis="strong" invalid>
        Email
      </trn-field-label>
      <input
        trnInput
        id="email"
        type="email"
        invalid
        aria-describedby="email-error"
      />
      <p id="email-error">Enter a valid address.</p>
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

  it('uses precise emphasis and validation state without changing the native label', async () => {
    const { container } = await render(HostComponent);
    const label = container.querySelector('label');

    expect(label?.getAttribute('data-slot')).toBe('label');
    expect(label?.getAttribute('data-emphasis')).toBe('strong');
    expect(label?.getAttribute('data-invalid')).toBe('true');
  });

  it('exposes field and control validation while preserving the description', async () => {
    const { container } = await render(HostComponent);
    const field = container.querySelector('trn-field');
    const control = container.querySelector('input');

    expect(field?.getAttribute('data-invalid')).toBe('true');
    expect(control?.getAttribute('aria-invalid')).toBe('true');
    expect(control?.getAttribute('aria-describedby')).toBe('email-error');
  });
});
