import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnBadge } from './trn-badge';
import {
  trnBadgeRecipe,
  type TrnBadgeSize,
  type TrnBadgeVariant,
} from './trn-badge-recipe';

@Component({
  imports: [TrnBadge],
  template: `<span trnBadge variant="success">Verified</span>`,
})
class HostComponent {}

describe('TrnBadge', () => {
  it('reflects our variant onto the host', async () => {
    // The defect control: `data-variant` is written by THIS directive, so removing it from
    // the template leaves the attribute absent.
    const { container } = await render(HostComponent);
    const badge = container.querySelector('span');

    expect(badge?.tagName).toBe('SPAN');
    expect(badge?.getAttribute('data-variant')).toBe('success');
  });

  it('maps every published semantic variant onto a distinct recipe', () => {
    const ours: TrnBadgeVariant[] = ['neutral', 'success', 'warning'];
    const rendered = ours.map((variant) => trnBadgeRecipe(variant, 'sm'));

    expect(new Set(rendered).size).toBe(ours.length);
  });

  it('keeps badge geometry to the compact subset', () => {
    const sizes: TrnBadgeSize[] = ['xs', 'sm', 'md'];
    expect(
      new Set(sizes.map((size) => trnBadgeRecipe('neutral', size))).size,
    ).toBe(sizes.length);
  });
});
