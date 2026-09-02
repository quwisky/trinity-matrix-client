import { describe, expect, it } from 'vitest';
import { resolveTrnAvatarSize, type TrnAvatarSize } from './trn-avatar-size';

describe('Trinity avatar size recipe', () => {
  it('maps the canonical scale onto stable pixel geometry', () => {
    const sizes: TrnAvatarSize[] = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];

    expect(sizes.map((size) => resolveTrnAvatarSize(size, null))).toEqual([
      16, 20, 24, 28, 32, 40, 48,
    ]);
  });

  it('bounds and prioritizes the exact geometry escape', () => {
    expect(resolveTrnAvatarSize('sm', 64)).toBe(64);
    expect(resolveTrnAvatarSize('sm', 2)).toBe(16);
    expect(resolveTrnAvatarSize('sm', 400)).toBe(256);
    expect(resolveTrnAvatarSize('sm', Number.NaN)).toBe(40);
  });
});
