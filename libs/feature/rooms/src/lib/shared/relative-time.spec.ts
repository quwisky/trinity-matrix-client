import { describe, expect, it } from 'vitest';
import { relativeTimeLabel } from './relative-time';

describe('relativeTimeLabel', () => {
  const now = 1_000_000_000;

  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [60_000, '1 min. ago'],
    [65 * 60_000, '1 hr. ago'],
    [25 * 60 * 60_000, '1 day ago'],
    [-60_000, 'just now'],
  ])('labels %i ms ago as %s', (age, label) => {
    expect(relativeTimeLabel(now - age, now)).toBe(label);
  });
});
