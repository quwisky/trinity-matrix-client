import { describe, expect, it } from 'vitest';
import { nextDetent, type TrnSheetDetent } from './sheet-detent';

const both: readonly TrnSheetDetent[] = ['medium', 'large'];

describe('nextDetent', () => {
  it('snaps up to large past the midpoint', () => {
    expect(nextDetent('medium', -200, 0, both, 768)).toBe('large');
  });

  it('stays at medium short of the midpoint', () => {
    expect(nextDetent('medium', -40, 0, both, 768)).toBe('medium');
  });

  it('goes to large on a fling up', () => {
    expect(nextDetent('medium', -30, -1.2, both, 768)).toBe('large');
  });

  it('comes down from large to medium', () => {
    expect(nextDetent('large', 200, 0, both, 768)).toBe('medium');
  });

  it('dismisses from medium past the threshold', () => {
    expect(nextDetent('medium', 200, 0, both, 768)).toBe('dismiss');
  });

  it('never rises to a detent the sheet does not offer', () => {
    expect(nextDetent('medium', -200, 0, ['medium'], 768)).toBe('medium');
  });

  it('flings down from large to medium, not closed', () => {
    expect(nextDetent('large', 30, 1.2, both, 768)).toBe('medium');
  });
});
