import { describe, expect, it } from 'vitest';
import { cssColorToHex } from './overlay-colors';

describe('cssColorToHex', () => {
  it('converts rgb() to #rrggbb', () => {
    expect(cssColorToHex('rgb(18, 18, 20)')).toBe('#121214');
    expect(cssColorToHex('rgba(219 222 225 / 1)')).toBe('#dbdee1');
  });

  it('returns null for an empty colour', () => {
    expect(cssColorToHex('')).toBeNull();
  });
});
