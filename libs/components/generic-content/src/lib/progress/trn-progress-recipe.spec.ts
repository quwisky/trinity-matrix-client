import { describe, expect, it } from 'vitest';
import {
  trnProgressIndicatorRecipe,
  trnProgressTrackRecipe,
  type TrnProgressSize,
  type TrnProgressVariant,
} from './trn-progress-recipe';

describe('Trinity progress recipe', () => {
  it('maps each applicable semantic treatment onto a distinct fill', () => {
    const variants: TrnProgressVariant[] = [
      'accent',
      'success',
      'warning',
      'danger',
    ];
    expect(new Set(variants.map(trnProgressIndicatorRecipe)).size).toBe(
      variants.length,
    );
  });

  it('maps only compact progress geometry', () => {
    const sizes: TrnProgressSize[] = ['xs', 'sm', 'md'];
    expect(new Set(sizes.map(trnProgressTrackRecipe)).size).toBe(sizes.length);
  });
});
