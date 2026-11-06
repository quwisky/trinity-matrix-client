import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { TrnActionAvailability, TrnButton, TrnIconButton } from './trn-button';
import { TRN_BUTTON_ROW_CONTEXT } from './trn-button-row-context';
import {
  type TrnButtonPresentation,
  type TrnButtonShape,
  type TrnButtonSize,
  type TrnButtonVariant,
} from './trn-button-recipe';

@Component({
  imports: [TrnButton, TrnIconButton],
  template: `<button trnBtn variant="danger" size="sm" disabled>Erase</button>`,
})
class HostComponent {}

@Component({
  imports: [TrnButton],
  template: `<button trnBtn loading disabled>Saving</button>`,
})
class LoadingHostComponent {}

@Component({
  imports: [TrnButton],
  template: `<button trnBtn shape="row" class="justify-center">
    Centred
  </button>`,
})
class OverrideHostComponent {}

@Component({
  imports: [TrnButton, TrnIconButton],
  template: `
    <button trnBtn size="md">Label</button>
    <button trnBtn shape="icon" size="md">Canonical icon</button>
    <button data-testid="dynamic" trnBtn [shape]="dynamicShape()">
      Dynamic
    </button>
    <a data-testid="icon-link" trnBtn shape="icon" size="md" href="#target"
      >Link</a
    >
    <button data-testid="bespoke" trnIconButton>Bespoke</button>
  `,
})
class IconHostComponent {
  readonly dynamicShape = signal<TrnButtonShape>('label');
}

@Component({
  imports: [TrnButton],
  template: `
    <button trnBtn disabled>Solid</button>
    <button
      trnBtn
      [presentation]="presentation()"
      [variant]="variant()"
      disabled
    >
      Dynamic
    </button>
  `,
})
class PresentationHostComponent {
  readonly presentation = signal<TrnButtonPresentation>('outline');
  readonly variant = signal<TrnButtonVariant>('danger');
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

const INLINE_CLASSES = [
  'px-0',
  'has-data-[icon=inline-end]:pe-0',
  'has-data-[icon=inline-start]:ps-0',
];

describe('TrnButton', () => {
  it('keeps a host layout class that Helm also emits, after another write to the class list', async () => {
    // Helm's base emits `justify-center` and the row shape `justify-start`. Any outside write
    // to `class` (a CDK focus class, a binding) re-reads the host classes, which once dropped
    // the host's copy and let the row shape win.
    const { fixture } = await render(OverrideHostComponent);
    const button = fixture.nativeElement.querySelector('button') as HTMLElement;
    button.classList.add('cdk-focused');
    await new Promise((resolve) => setTimeout(resolve));

    expect(button.classList).toContain('justify-center');
    expect(button.classList).not.toContain('justify-start');
    expect(button.classList).toContain('cdk-focused');
  });

  it('applies through the directive', async () => {
    @Component({
      imports: [TrnButton],
      template: `<button trnBtn presentation="link" shape="inline" size="sm">
        Preview
      </button>`,
    })
    class InlineHostComponent {}

    const { fixture } = await render(InlineHostComponent);
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button',
    ) as HTMLButtonElement;

    expect([...button.classList]).toEqual(
      expect.arrayContaining(INLINE_CLASSES),
    );
    expect(button.classList).not.toContain('px-2.5');
    expect(button.hasAttribute('data-trn-icon-button')).toBe(false);
  });
  it('keeps the Helm substrate private while preserving native button semantics', async () => {
    const { container } = await render(HostComponent);
    const button = container.querySelector('button');

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('data-slot')).toBe('button');
  });

  it('announces a loading action without replacing native disabled semantics', async () => {
    const { container } = await render(LoadingHostComponent);
    const button = container.querySelector('button');

    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.hasAttribute('data-loading')).toBe(true);
    expect(button?.disabled).toBe(true);
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

  it('marks icon recipes without marking labels', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const buttons = [...container.querySelectorAll('button')];

    expect(buttons[0].hasAttribute('data-trn-icon-button')).toBe(false);
    expect(buttons[1].hasAttribute('data-trn-icon-button')).toBe(true);
    expect(buttons[2].hasAttribute('data-trn-icon-button')).toBe(false);
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

  it('updates the marker when a bound shape changes', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const host = fixture.componentInstance;
    const dynamic = container.querySelector('[data-testid="dynamic"]')!;

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(false);

    host.dynamicShape.set('icon');
    await fixture.whenStable();

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(true);
  });

  it('publishes its presentation and variant for the shared disabled treatment', async () => {
    const { container, fixture } = await render(PresentationHostComponent);
    const host = fixture.componentInstance;
    const [solid, dynamic] = [...container.querySelectorAll('button')];

    expect(solid.getAttribute('data-trn-presentation')).toBe('solid');
    expect(solid.getAttribute('data-trn-variant')).toBe('primary');
    expect(dynamic.getAttribute('data-trn-presentation')).toBe('outline');
    expect(dynamic.getAttribute('data-trn-variant')).toBe('danger');

    host.presentation.set('ghost');
    host.variant.set('secondary');
    await fixture.whenStable();

    expect(dynamic.getAttribute('data-trn-presentation')).toBe('ghost');
    expect(dynamic.getAttribute('data-trn-variant')).toBe('secondary');
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

  describe('in a row context', () => {
    @Component({
      imports: [TrnButton],
      providers: [{ provide: TRN_BUTTON_ROW_CONTEXT, useValue: signal(true) }],
      template: `
        <button trnBtn data-testid="primary">Save</button>
        <button trnBtn variant="secondary" presentation="link">Skip</button>
        <button trnBtn variant="danger" disabled>Delete</button>
      `,
    })
    class RowContextHostComponent {}

    @Component({
      imports: [TrnButton],
      providers: [{ provide: TRN_BUTTON_ROW_CONTEXT, useValue: signal(false) }],
      template: `<button trnBtn>Save</button>`,
    })
    class OffContextHostComponent {}

    it('turns every button into a full-width centred row that overrides the recipe geometry', async () => {
      const { container } = await render(RowContextHostComponent);

      for (const button of container.querySelectorAll('button')) {
        expect(button.getAttribute('data-trn-shape')).toBe('row');
        for (const cls of [
          'w-full',
          'justify-center',
          'rounded-none',
          'p-4',
          'text-base',
        ]) {
          expect(button.classList).toContain(cls);
        }
        expect(button.classList).not.toContain('px-2.5');
        expect(button.classList).not.toContain('rounded-lg');
        expect(button.classList).not.toContain('justify-start');
        expect(button.classList).not.toContain('text-sm');
      }
    });

    it('maps primary to semibold secondary solid, others to secondary solid and danger to ghost', async () => {
      const { getByRole } = await render(RowContextHostComponent);

      const save = getByRole('button', { name: 'Save' });
      expect(save.getAttribute('data-trn-presentation')).toBe('solid');
      expect(save.classList).toContain('font-semibold');
      expect(save.classList).toContain(
        'bg-[color:var(--trinity-neutral-fill-surface)]',
      );
      expect(save.classList).not.toContain('bg-primary');

      const skip = getByRole('button', { name: 'Skip' });
      expect(skip.getAttribute('data-trn-presentation')).toBe('solid');
      expect(skip.classList).not.toContain('font-semibold');
      expect(skip.classList).not.toContain('underline-offset-4');

      const remove = getByRole('button', { name: 'Delete' });
      expect(remove.getAttribute('data-trn-variant')).toBe('danger');
      expect(remove.getAttribute('data-trn-presentation')).toBe('ghost');
      expect(remove.classList).toContain('text-danger');
      expect((remove as HTMLButtonElement).disabled).toBe(true);
    });

    it('leaves the button alone when the context is false', async () => {
      const { getByRole } = await render(OffContextHostComponent);

      const save = getByRole('button', { name: 'Save' });
      expect(save.getAttribute('data-trn-shape')).toBe('label');
      expect(save.classList).not.toContain('p-4');
    });
  });
});
