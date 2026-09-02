import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TrnCardImports,
  type TrnCardSize,
  type TrnCardVariant,
} from './trn-card';
import { trnCardRecipe } from './trn-card-recipe';

@Component({
  imports: [TrnCardImports],
  template: `
    <section trnCard variant="muted" size="sm" class="w-full">
      <div trnCardHeader>
        <h2 trnCardTitle>Sign in</h2>
        <p trnCardDescription>Pick a homeserver</p>
      </div>
      <div trnCardContent>body</div>
    </section>
  `,
})
class HostComponent {}

describe('TrnCard', () => {
  it('exposes only meaningful surfaces and geometry', () => {
    expectTypeOf<TrnCardVariant>().toEqualTypeOf<'neutral' | 'muted'>();
    expectTypeOf<TrnCardSize>().toEqualTypeOf<'sm' | 'md'>();

    expect(trnCardRecipe('neutral', 'md')).toContain(
      'bg-[var(--trinity-surface-card)]',
    );
    expect(trnCardRecipe('muted', 'sm')).toContain(
      '[--card-spacing:--spacing(3)]',
    );
  });

  it('keeps the call site’s semantics and composes each kit slot', async () => {
    const { container } = await render(HostComponent);

    // The reason these are attributes: the call site chose section/h2/p, and the document
    // outline depends on keeping them. An element wrapper would have replaced all three.
    expect(container.querySelector('section')?.getAttribute('data-slot')).toBe(
      'card',
    );
    expect(container.querySelector('h2')?.getAttribute('data-slot')).toBe(
      'card-title',
    );
    expect(container.querySelector('p')?.getAttribute('data-slot')).toBe(
      'card-description',
    );
    // The defect control: `data-slot` arrives only through the composed kit directives.
    expect(
      container.querySelector('div[trnCardContent]')?.getAttribute('data-slot'),
    ).toBe('card-content');
    expect(
      container.querySelector('section')?.getAttribute('data-variant'),
    ).toBe('muted');
    expect(container.querySelector('section')?.getAttribute('data-size')).toBe(
      'sm',
    );
    expect(container.querySelector('section')?.className).toContain('w-full');
  });
});
