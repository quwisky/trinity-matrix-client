import { describe, expect, it } from 'vitest';
import { nextDetent, type TrnSheetDetent } from './sheet-detent';

/** jsdom's 768px viewport, measured: half and full height, starting at rest. */
const at = (current: TrnSheetDetent) => ({
  start: current === 'large' ? 768 : 384,
  medium: 384,
  large: 768,
});
/** An 844px phone with a 59px top inset. */
const notched = (start: number) => ({ start, medium: 422, large: 785 });

const both: readonly TrnSheetDetent[] = ['medium', 'large'];

describe('nextDetent', () => {
  it('snaps up to large past the midpoint', () => {
    expect(nextDetent('medium', -200, 0, both, at('medium'))).toBe('large');
  });

  it('stays at medium short of the midpoint', () => {
    expect(nextDetent('medium', -40, 0, both, at('medium'))).toBe('medium');
  });

  it('goes to large on a fling up', () => {
    expect(nextDetent('medium', -30, -1.2, both, at('medium'))).toBe('large');
  });

  it('comes down from large to medium', () => {
    expect(nextDetent('large', 200, 0, both, at('large'))).toBe('medium');
  });

  it('dismisses from medium past the threshold', () => {
    expect(nextDetent('medium', 200, 0, both, at('medium'))).toBe('dismiss');
  });

  it('never rises to a detent the sheet does not offer', () => {
    expect(nextDetent('medium', -200, 0, ['medium'], at('medium'))).toBe(
      'medium',
    );
  });

  it('flings down from large to medium, not closed', () => {
    expect(nextDetent('large', 30, 1.2, both, at('large'))).toBe('medium');
  });

  it('snaps on measured heights on a phone with a 59px top inset', () => {
    expect(nextDetent('medium', -200, 0, both, notched(422))).toBe('large');
    expect(nextDetent('large', 360, 0, both, notched(785))).toBe('medium');
    expect(nextDetent('large', 480, 0, both, notched(785))).toBe('dismiss');
  });

  it('measures a re-grab from where the sheet is, not its target', () => {
    expect(nextDetent('large', 150, 0, both, notched(600))).toBe('medium');
  });
});
