import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TrnSeparatorDirective,
  type TrnSeparatorVariant,
} from './trn-separator.directive';
import { trnSeparatorRecipe } from './trn-separator-recipe';

@Component({
  imports: [TrnSeparatorDirective],
  template: `
    <div
      trnSeparator
      data-t="announced"
      orientation="vertical"
      variant="accent"
      [decorative]="false"
    ></div>
    <div trnSeparator data-t="default"></div>
  `,
})
class HostComponent {}

describe('TrnSeparatorDirective', () => {
  it('limits appearance to neutral and accent treatments', () => {
    expectTypeOf<TrnSeparatorVariant>().toEqualTypeOf<'neutral' | 'accent'>();
    expect(trnSeparatorRecipe('neutral')).toContain(
      'bg-[var(--trinity-border-control)]',
    );
    expect(trnSeparatorRecipe('accent')).toContain(
      'bg-[var(--trinity-state-attention-surface)]',
    );
  });

  it('announces itself when the caller says it means something', async () => {
    // The public directive explicitly re-publishes Brain's behavior inputs. This runtime
    // assertion complements the strict-template contract that rejects unsupported values.
    const { container } = await render(HostComponent);

    const rule = container.querySelector('[data-t="announced"]')!;
    expect(rule.getAttribute('role')).toBe('separator');
    expect(rule.getAttribute('data-orientation')).toBe('vertical');
    expect(rule.getAttribute('data-variant')).toBe('accent');
  });

  it('is decoration by default, as upstream has it', async () => {
    // Not inverted locally: a regenerate would put it back and every call site would quietly
    // change meaning. A caller who wants the rule heard asks for it.
    const { container } = await render(HostComponent);

    const rule = container.querySelector('[data-t="default"]')!;
    expect(rule.getAttribute('role')).toBe('none');
  });
});
