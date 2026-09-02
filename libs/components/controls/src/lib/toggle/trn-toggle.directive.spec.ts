import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { TrnToggleDirective } from './trn-toggle.directive';
import {
  type TrnTogglePresentation,
  type TrnToggleSize,
  type TrnToggleVariant,
} from './trn-toggle-recipe';

@Component({
  imports: [TrnToggleDirective],
  template: `
    <button
      trnToggle
      variant="accent"
      presentation="outline"
      size="sm"
      [pressed]="pressed()"
      [readOnly]="readOnly()"
      [disabled]="disabled()"
      (pressedChange)="pressed.set($event)"
      (click)="clicks.update((value) => value + 1)"
    >
      Preview
    </button>
  `,
})
class HostComponent {
  readonly pressed = signal(false);
  readonly readOnly = signal(false);
  readonly disabled = signal(false);
  readonly clicks = signal(0);
}

describe('TrnToggleDirective', () => {
  it('exposes only semantic variants, ordinal sizes and intentional presentations', () => {
    expectTypeOf<TrnToggleVariant>().toEqualTypeOf<'neutral' | 'accent'>();
    expectTypeOf<'danger'>().not.toExtend<TrnToggleVariant>();
    expectTypeOf<TrnToggleSize>().toEqualTypeOf<'sm' | 'md' | 'lg'>();
    expectTypeOf<'xl'>().not.toExtend<TrnToggleSize>();
    expectTypeOf<TrnTogglePresentation>().toEqualTypeOf<'plain' | 'outline'>();
  });

  it('reports and updates pressed state through native button activation', async () => {
    const { container, fixture } = await render(HostComponent);
    const button = container.querySelector('button')!;

    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('data-state')).toBe('off');

    button.click();
    await fixture.whenStable();

    expect(fixture.componentInstance.pressed()).toBe(true);
    expect(fixture.componentInstance.clicks()).toBe(1);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('data-state')).toBe('on');
  });

  it('keeps read-only state focusable and blocks consumer activation', async () => {
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.readOnly.set(true);
    await fixture.whenStable();
    const button = container.querySelector('button')!;

    button.focus();
    button.click();
    await fixture.whenStable();

    expect(document.activeElement).toBe(button);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(fixture.componentInstance.pressed()).toBe(false);
    expect(fixture.componentInstance.clicks()).toBe(0);
  });

  it('preserves native disabled behavior', async () => {
    const { container, fixture } = await render(HostComponent);
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();
    const button = container.querySelector('button')!;

    button.click();

    expect(fixture.componentInstance.pressed()).toBe(false);
    expect(fixture.componentInstance.clicks()).toBe(0);
  });
});
