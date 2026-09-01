import { describe, expect, it } from 'vitest';
import { resolveTrnIconSize, type TrnIconSize } from './trn-icon-recipe';

describe('Trinity icon recipe', () => {
  it('maps every canonical size onto a distinct ordinal step', () => {
    const sizes: TrnIconSize[] = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    const resolved = sizes.map((size) => resolveTrnIconSize(size));

    expect(resolved).toEqual([
      '0.75rem',
      '0.875rem',
      '1rem',
      '1.125rem',
      '1.25rem',
      '1.5rem',
      '2rem',
    ]);
    expect(new Set(resolved).size).toBe(sizes.length);
  });

  it('retains exact CSS lengths and inherited sizing during expansion', () => {
    expect(resolveTrnIconSize('1.25rem')).toBe('1.25rem');
    expect(resolveTrnIconSize(null)).toBe('');
  });
});
