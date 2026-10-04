import { Component, signal } from '@angular/core';
import { FormField, form, required, submit } from '@angular/forms/signals';
import { fireEvent, render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnInput } from './trn-input';
import { trnInputRecipe } from './trn-text-control-recipe';

@Component({
  imports: [TrnInput],
  template: `
    <input
      trnInput
      id="gw"
      size="sm"
      explicitInvalid
      aria-describedby="gw-help"
    />
    <p id="gw-help">Where push notifications are sent.</p>
  `,
})
class HostComponent {}

@Component({
  imports: [TrnInput, FormField],
  template: `<input trnInput [formField]="f.name" />`,
})
class RequiredHostComponent {
  readonly f = form(signal({ name: '' }), (p) => required(p.name));
  send() {
    return submit(this.f, async () => undefined);
  }
}

describe('TrnInput', () => {
  it('marks a required empty field invalid only after blur or a submit attempt', async () => {
    const { container, fixture } = await render(RequiredHostComponent);
    const el = container.querySelector('input') as HTMLInputElement;

    expect(el.getAttribute('aria-invalid')).toBeNull();
    expect(el.hasAttribute('data-invalid')).toBe(false);

    fireEvent.blur(el);
    fixture.detectChanges();
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  it('marks a required empty field invalid after a submit attempt', async () => {
    const { container, fixture } = await render(RequiredHostComponent);
    await fixture.componentInstance.send();
    fixture.detectChanges();
    expect(container.querySelector('input')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('keeps the consumer’s aria-describedby, which the kit silently wiped once', async () => {
    // #153: BrnFieldControlDescribedBy owns [attr.aria-describedby] as a host binding, so a
    // consumer's value is computed as null and removed unless the composed entry publishes
    // the input. This asserts `trnInput` still lists it in its `hostDirectives` entry.
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
    expect(el?.getAttribute('data-size')).toBe('sm');
    expect(el?.getAttribute('aria-invalid')).toBe('true');
  });

  it('resolves size and validation through the synchronous recipe', () => {
    const recipe = trnInputRecipe('sm', true);

    expect(recipe).toContain('min-h-[max(1.75rem');
    expect(recipe).toContain('border-danger');
  });
});
