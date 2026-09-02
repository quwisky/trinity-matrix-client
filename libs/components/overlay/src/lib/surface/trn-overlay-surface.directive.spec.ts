import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  trnOverlaySurfaceRecipe,
  type TrnOverlaySurfaceLayout,
  type TrnOverlaySurfaceSize,
  type TrnOverlaySurfaceVariant,
} from './trn-overlay-surface-recipe';

describe('Trinity overlay surface recipe', () => {
  it('keeps semantic treatment independent from size and layout', () => {
    const neutral = trnOverlaySurfaceRecipe('neutral', 'sm', 'dialog');
    const accent = trnOverlaySurfaceRecipe('accent', 'sm', 'dialog');
    const panel = trnOverlaySurfaceRecipe('neutral', 'xl', 'panel');

    expect(neutral).toContain('var(--trinity-surface-raised)');
    expect(accent).toContain('var(--trinity-state-attention-surface)');
    expect(neutral).toContain('--trn-overlay-inline-size:20rem');
    expect(panel).toContain('--trn-overlay-inline-size:40rem');
    expect(panel).toContain('w-screen');
    expect(panel).toContain('h-dvh');
  });

  it('publishes bounded Trinity vocabulary', () => {
    expectTypeOf<TrnOverlaySurfaceVariant>().toEqualTypeOf<
      'neutral' | 'accent'
    >();
    expectTypeOf<TrnOverlaySurfaceSize>().toEqualTypeOf<
      'sm' | 'md' | 'lg' | 'xl'
    >();
    expectTypeOf<TrnOverlaySurfaceLayout>().toEqualTypeOf<
      'dialog' | 'sheet' | 'popover' | 'panel' | 'fullscreen'
    >();
  });
});
