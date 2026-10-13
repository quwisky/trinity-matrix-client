import { describe, expect, it } from 'vitest';
import { trimTrailing } from './trim-trailing';

describe('trimTrailing', () => {
  it('returns the value unchanged without a trailing set character', () => {
    expect(trimTrailing('abc', '.,')).toBe('abc');
    expect(trimTrailing('', '.,')).toBe('');
  });

  it('trims one, many and mixed trailing set characters', () => {
    expect(trimTrailing('abc.', '.,')).toBe('abc');
    expect(trimTrailing('abc....', '.,')).toBe('abc');
    expect(trimTrailing('abc.,.,', '.,')).toBe('abc');
  });

  it('keeps set characters that are not at the end', () => {
    expect(trimTrailing('a.b,c.', '.,')).toBe('a.b,c');
  });

  it('keeps a non-BMP character before the trimmed run intact', () => {
    expect(trimTrailing('a\u{1F600}.', '.,')).toBe('a\u{1F600}');
  });

  it('trims a value made only of set characters to empty', () => {
    expect(trimTrailing('.,.', '.,')).toBe('');
  });
});
