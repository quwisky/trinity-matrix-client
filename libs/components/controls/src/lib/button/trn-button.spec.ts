import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { TrnActionAvailability, TrnButton, TrnIconButton } from './trn-button';
import {
  trnButtonRecipe,
  type TrnButtonPresentation,
  type TrnButtonShape,
  type TrnButtonSize,
  type TrnButtonVariant,
} from './trn-button-recipe';

@Component({
  imports: [TrnButton, TrnIconButton],
  template: `<button trnBtn variant="destructive" size="sm" disabled>
    Erase
  </button>`,
})
class HostComponent {}

@Component({
  imports: [TrnButton, TrnIconButton],
  template: `
    @for (size of iconSizes; track size) {
      <button trnBtn [size]="size">Icon</button>
    }
    <button trnBtn size="md">Label</button>
    <button trnBtn shape="icon" size="md">Canonical icon</button>
    <button data-testid="dynamic" trnBtn [shape]="dynamicShape()">
      Dynamic
    </button>
    <a data-testid="icon-link" trnBtn size="icon" href="#target">Link</a>
    <button data-testid="bespoke" trnIconButton>Bespoke</button>
  `,
})
class IconHostComponent {
  readonly iconSizes = ['icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const;
  readonly dynamicShape = signal<TrnButtonShape>('label');
}

@Component({
  imports: [TrnActionAvailability],
  template: `<button
    [trnActionAllowed]="allowed()"
    trnActionDisabledReason="Only room admins can do this."
    (click)="activations.update((value) => value + 1)"
  >
    Restricted action
  </button>`,
})
class AvailabilityHostComponent {
  readonly allowed = signal(false);
  readonly activations = signal(0);
}

describe('TrnButton', () => {
  it('keeps the Helm substrate private while preserving native button semantics', async () => {
    const { container } = await render(HostComponent);
    const button = container.querySelector('button');

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('data-slot')).toBe('button');
  });

  it('exposes only the button subset of the canonical vocabulary', () => {
    expectTypeOf<TrnButtonVariant>().toEqualTypeOf<
      'primary' | 'secondary' | 'danger'
    >();
    expectTypeOf<'success'>().not.toExtend<TrnButtonVariant>();
    expectTypeOf<TrnButtonSize>().toEqualTypeOf<'xs' | 'sm' | 'md' | 'lg'>();
    expectTypeOf<'xl'>().not.toExtend<TrnButtonSize>();
    expectTypeOf<TrnButtonPresentation>().toEqualTypeOf<
      'solid' | 'outline' | 'ghost' | 'link'
    >();
  });

  it('renders canonical and compatibility inputs through equivalent recipes', () => {
    expect(
      trnButtonRecipe({
        presentation: 'solid',
        shape: 'label',
        size: 'md',
        variant: 'primary',
      }),
    ).toBe(
      trnButtonRecipe({
        presentation: 'solid',
        shape: 'label',
        size: 'default',
        variant: 'default',
      }),
    );
    expect(
      trnButtonRecipe({
        presentation: 'solid',
        shape: 'label',
        size: 'md',
        variant: 'danger',
      }),
    ).toBe(
      trnButtonRecipe({
        presentation: 'solid',
        shape: 'label',
        size: 'default',
        variant: 'destructive',
      }),
    );
    expect(
      trnButtonRecipe({
        presentation: 'ghost',
        shape: 'icon',
        size: 'md',
        variant: 'primary',
      }),
    ).toBe(
      trnButtonRecipe({
        presentation: 'solid',
        shape: 'label',
        size: 'icon',
        variant: 'ghost',
      }),
    );
  });

  it('marks canonical and compatibility icon recipes without marking labels', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const buttons = [...container.querySelectorAll('button')];

    expect(
      buttons
        .slice(0, 4)
        .every((button) => button.hasAttribute('data-trn-icon-button')),
    ).toBe(true);
    expect(buttons[4].hasAttribute('data-trn-icon-button')).toBe(false);
    expect(buttons[5].hasAttribute('data-trn-icon-button')).toBe(true);
    expect(buttons[6].hasAttribute('data-trn-icon-button')).toBe(false);
    expect(
      container
        .querySelector('[data-testid="icon-link"]')
        ?.hasAttribute('data-trn-icon-button'),
    ).toBe(true);
    expect(
      fixture.debugElement.queryAll(By.directive(TrnIconButton)),
    ).toHaveLength(1);
    expect(
      container
        .querySelector('[data-testid="bespoke"]')
        ?.hasAttribute('data-trn-icon-button'),
    ).toBe(true);
  });

  it('updates the marker when a bound size changes', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const host = fixture.componentInstance;
    const dynamic = container.querySelector('[data-testid="dynamic"]')!;

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(false);

    host.dynamicShape.set('icon');
    await fixture.whenStable();

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(true);
  });

  it('keeps unavailable actions focusable and blocks pointer or keyboard activation', async () => {
    const { container, fixture } = await render(AvailabilityHostComponent);
    const host = fixture.componentInstance;
    const button = container.querySelector('button')!;

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-description')).toBe(
      'Only room admins can do this.',
    );

    button.click();
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const space = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    expect(button.dispatchEvent(enter)).toBe(false);
    expect(enter.defaultPrevented).toBe(true);
    expect(button.dispatchEvent(space)).toBe(false);
    expect(space.defaultPrevented).toBe(true);
    expect(host.activations()).toBe(0);

    host.allowed.set(true);
    await fixture.whenStable();
    button.click();
    expect(host.activations()).toBe(1);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('shows the unavailable reason after a touch tap', async () => {
    const { container } = await render(AvailabilityHostComponent);
    const button = container.querySelector('button')!;
    const touch = new Event('touchend', { bubbles: true, cancelable: true });

    button.dispatchEvent(touch);

    expect(
      document.querySelector('[data-testid="action-unavailable-feedback"]')
        ?.textContent,
    ).toBe('Only room admins can do this.');
  });
});
