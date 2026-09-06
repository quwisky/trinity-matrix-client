import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  trnOverlaySurfaceRecipe,
  type TrnOverlaySurfaceLayout,
  type TrnOverlaySurfaceSize,
  type TrnOverlaySurfaceVariant,
} from './trn-overlay-surface-recipe';
import { TrnOverlaySurfaceDirective } from './trn-overlay-surface.directive';

@Component({
  imports: [TrnOverlaySurfaceDirective],
  template: `
    <section
      trnOverlaySurface
      variant="accent"
      size="lg"
      layout="panel"
      data-testid="surface"
    ></section>
  `,
})
class HostComponent {}

describe('Trinity overlay surface recipe', () => {
  it('keeps semantic treatment independent from size and layout', () => {
    const neutral = trnOverlaySurfaceRecipe('neutral', 'sm', 'dialog');
    const accent = trnOverlaySurfaceRecipe('accent', 'sm', 'dialog');
    const sheet = trnOverlaySurfaceRecipe('neutral', 'md', 'sheet');
    const panel = trnOverlaySurfaceRecipe('neutral', 'xl', 'panel');
    const workspace = trnOverlaySurfaceRecipe('neutral', '2xl', 'workspace');

    expect(neutral).toContain('var(--trinity-surface-raised)');
    expect(accent).toContain('var(--trinity-state-attention-surface)');
    expect(neutral).toContain('--trn-overlay-inline-size:20rem');
    expect(sheet).toContain('w-screen');
    expect(sheet).toContain('max-w-[100vw]');
    expect(sheet).toContain('rounded-b-none');
    expect(sheet).toContain('border-x-0');
    expect(sheet).toContain('border-b-0');
    expect(panel).toContain('--trn-overlay-inline-size:40rem');
    expect(panel).toContain('w-screen');
    expect(panel).toContain('h-dvh');
    expect(workspace).toContain('--trn-overlay-inline-size:72rem');
    expect(workspace).toContain('100vw-2*var(--trinity-space-4)');
    expect(workspace).toContain('100dvh-2*var(--trinity-space-4)');
    expect(workspace).toContain('flex');
    expect(workspace).not.toMatch(/\bblock\b/u);
    expect(trnOverlaySurfaceRecipe('neutral', '2xl', 'fullscreen')).toContain(
      'flex',
    );
  });

  it('publishes bounded Trinity vocabulary', () => {
    expectTypeOf<TrnOverlaySurfaceVariant>().toEqualTypeOf<
      'neutral' | 'accent'
    >();
    expectTypeOf<TrnOverlaySurfaceSize>().toEqualTypeOf<
      'sm' | 'md' | 'lg' | 'xl' | '2xl'
    >();
    expectTypeOf<TrnOverlaySurfaceLayout>().toEqualTypeOf<
      'dialog' | 'sheet' | 'popover' | 'panel' | 'workspace' | 'fullscreen'
    >();
  });

  it('renders the directive vocabulary as stable host metadata', async () => {
    const { getByTestId } = await render(HostComponent);
    const surface = getByTestId('surface');

    expect(surface.getAttribute('data-trn-variant')).toBe('accent');
    expect(surface.getAttribute('data-trn-size')).toBe('lg');
    expect(surface.getAttribute('data-trn-layout')).toBe('panel');
  });
});
