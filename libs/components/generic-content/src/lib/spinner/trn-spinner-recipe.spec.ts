import { describe, expect, it } from 'vitest';
import {
  trnSpinnerRecipe,
  type TrnSpinnerSize,
  type TrnSpinnerVariant,
} from './trn-spinner-recipe';

describe('Trinity spinner recipe', () => {
  it('maps the bounded size scale onto distinct geometry', () => {
    const sizes: TrnSpinnerSize[] = ['xs', 'sm', 'md', 'lg'];
    expect(
      new Set(sizes.map((size) => trnSpinnerRecipe(size, null))).size,
    ).toBe(sizes.length);
  });

  it('maps semantic inks while allowing inherited surrounding ink', () => {
    const variants: TrnSpinnerVariant[] = [
      'neutral',
      'muted',
      'accent',
      'danger',
    ];
    expect(
      new Set(variants.map((variant) => trnSpinnerRecipe('md', variant))).size,
    ).toBe(variants.length);
    expect(trnSpinnerRecipe('md', null)).not.toContain('text-[var(');
  });
});
