import { describe, expect, it } from 'vitest';
import { formatMediaDuration } from './format-media-duration';

describe('formatMediaDuration', () => {
  it('formats m:ss, and h:mm:ss from an hour up', () => {
    expect(formatMediaDuration(12_500)).toBe('0:13');
    expect(formatMediaDuration(72_000)).toBe('1:12');
    expect(formatMediaDuration(3_725_000)).toBe('1:02:05');
  });

  it('is null when the length is unknown', () => {
    for (const bad of [undefined, -1, Number.NaN]) {
      expect(formatMediaDuration(bad)).toBeNull();
    }
  });
});
