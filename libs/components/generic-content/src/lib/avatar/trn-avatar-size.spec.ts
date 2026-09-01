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

  it('keeps numeric size inputs valid during expansion', () => {
    expect(resolveTrnAvatarSize(36, null)).toBe(36);
    expect(resolveTrnAvatarSize(20.5, null)).toBe(20.5);
    expect(resolveTrnAvatarSize(12, null)).toBe(12);
    expect(resolveTrnAvatarSize(300, null)).toBe(300);
    expect(resolveTrnAvatarSize(Number.NaN, null)).toBe(40);
  });
});
