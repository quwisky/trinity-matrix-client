import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TRN_SIZES,
  TRN_VARIANTS,
  type TrnSize,
  type TrnVariant,
} from './trn-recipe-vocabulary';

describe('Trinity recipe vocabulary', () => {
  it('publishes stable semantic variants as constant data and a literal union', () => {
    expect(TRN_VARIANTS).toEqual([
      'primary',
      'secondary',
      'neutral',
      'accent',
      'muted',
      'danger',
      'success',
      'warning',
    ]);
    expectTypeOf<TrnVariant>().toEqualTypeOf<
      | 'primary'
      | 'secondary'
      | 'neutral'
      | 'accent'
      | 'muted'
      | 'danger'
      | 'success'
      | 'warning'
    >();
  });

  it('publishes stable ordinal sizes as constant data and a literal union', () => {
    expect(TRN_SIZES).toEqual(['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']);
    expectTypeOf<TrnSize>().toEqualTypeOf<
      '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
    >();
  });
});
