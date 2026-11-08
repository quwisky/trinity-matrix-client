import { Component, signal, viewChild, viewChildren } from '@angular/core';
import {
  disabled,
  FormField,
  form,
  required,
  submit,
} from '@angular/forms/signals';
import { fireEvent, render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnInput } from './trn-input';
import { TRN_DEFAULT_LOCK_REASON } from './trn-lockable-control';
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

@Component({
  imports: [TrnInput],
  template: `
    <input trnInput [disabled]="disabled()" />
    <input
      trnInput
      [disabled]="disabled()"
      disabledReason="Wait for your changes to save"
    />
    <input trnInput size="sm" [disabled]="disabled()" />
  `,
})
class LockHostComponent {
  readonly disabled = signal(false);
  readonly inputs = viewChildren(TrnInput);
}

@Component({
  imports: [TrnInput, FormField],
  template: `<input trnInput [formField]="f.name" />`,
})
class FormLockHostComponent {
  readonly busy = signal(false);
  readonly f = form(signal({ name: '' }), (p) =>
    disabled(p.name, {
      when: () => this.busy() && 'Wait for sign-in to finish',
    }),
  );
  readonly input = viewChild.required(TrnInput);
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

  it('draws the composer’s fill, radius and inset focus ring, with a dashed disabled edge', () => {
    const recipe = trnInputRecipe('md').split(' ');

    expect(recipe).toEqual(
      expect.arrayContaining([
        'bg-[var(--trinity-entry-surface)]',
        'rounded-[var(--trinity-entry-radius)]',
        'border-[var(--trinity-entry-border)]',
        'text-[length:var(--trinity-text-base)]',
        'leading-[1.4]',
        'focus-visible:outline-[color:var(--trinity-focus-ring)]',
        'focus-visible:outline-offset-[calc(-1*var(--trinity-focus-ring-width))]',
        'disabled:border-dashed',
        'disabled:bg-transparent',
        'disabled:text-[var(--trinity-text-muted)]',
        'disabled:opacity-100',
        '[&[readonly]]:bg-transparent',
      ]),
    );
    expect(recipe.some((token) => token.includes('shadow'))).toBe(false);
  });

  it('keeps each size’s height', () => {
    expect(trnInputRecipe('sm')).toContain(
      'min-h-[max(1.75rem,var(--trinity-interaction-target-min-size))]',
    );
    expect(trnInputRecipe('md')).toContain(
      'min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))]',
    );
    expect(trnInputRecipe('lg')).toContain(
      'min-h-[max(2.5rem,var(--trinity-interaction-target-min-size))]',
    );
  });

  it('explains a disabled field, preferring the caller’s reason over the form’s', async () => {
    const { container, fixture } = await render(LockHostComponent);
    const host = fixture.componentInstance;
    const [plain, reasoned, small] = host.inputs();
    await fixture.whenStable();

    expect(plain.lockReason()).toBeNull();

    host.disabled.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(container.querySelectorAll('input:disabled')).toHaveLength(3);
    expect(plain.lockReason()).toBe(TRN_DEFAULT_LOCK_REASON);
    expect(reasoned.lockReason()).toBe('Wait for your changes to save');
    // A small field has no room for the lock; it keeps only the dashed look.
    expect(small.lockReason()).toBeNull();
  });

  it('takes a Signal Forms disabled reason', async () => {
    const { fixture } = await render(FormLockHostComponent);
    fixture.componentInstance.busy.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.input().lockReason()).toBe(
      'Wait for sign-in to finish',
    );
  });

  it('switches its value, placeholder and resting border only inside an attention surface', () => {
    const attention = 'in-data-[trn-surface=attention]:';
    const recipe = trnInputRecipe('md').split(' ');

    // The neutral roles stay the default; the attention roles only add a scoped override.
    expect(recipe).toEqual(
      expect.arrayContaining([
        'border-[var(--trinity-entry-border)]',
        'text-[var(--trinity-text-bright)]',
        'placeholder:text-[var(--trinity-text-muted)]',
        `${attention}border-[var(--trinity-state-attention-control-border)]`,
        `${attention}text-[var(--trinity-state-attention-control-foreground)]`,
        `${attention}placeholder:text-[var(--trinity-state-attention-control-placeholder)]`,
        `${attention}bg-transparent`,
        `${attention}disabled:border-[var(--trinity-state-attention-control-border)]`,
        `${attention}disabled:text-[var(--trinity-state-attention-control-placeholder)]`,
      ]),
    );
    expect(recipe.filter((token) => token.includes('attention'))).toEqual(
      recipe.filter((token) => token.startsWith(attention)),
    );
  });
  it('marks an invalid field and its file button label with attention roles only inside an attention surface', () => {
    const recipe = trnInputRecipe('md').split(' ');

    expect(recipe).toEqual(
      expect.arrayContaining([
        'data-[matches-spartan-invalid=true]:border-danger',
        'data-[matches-spartan-invalid=true]:outline-[color:var(--trinity-danger)]',
        'file:text-[var(--trinity-text-bright)]',
        'in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)]',
        'in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:outline-[color:var(--trinity-state-attention-control-danger)]',
        'in-data-[trn-surface=attention]:file:text-[var(--trinity-state-attention-control-foreground)]',
        // Focused, the danger ring would otherwise out-rank the focus ring.
        'in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:focus-visible:outline-[color:var(--trinity-focus-ring)]',
      ]),
    );
    expect(recipe.filter((token) => token.includes('attention'))).toEqual(
      recipe.filter((token) =>
        token.startsWith('in-data-[trn-surface=attention]:'),
      ),
    );
  });
});
