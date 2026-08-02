import { describe, expect, it } from 'vitest';
import {
  TYPING_REFRESH_MS,
  TYPING_TIMEOUT_MS,
  formatTypingNotice,
} from './typing';

describe('formatTypingNotice', () => {
  it('returns an empty string when nobody is typing', () => {
    expect(formatTypingNotice([])).toBe('');
  });

  it('names a single typist', () => {
    expect(formatTypingNotice(['Alice'])).toBe('Alice is typing…');
  });

  it('joins two typists with "and"', () => {
    expect(formatTypingNotice(['Alice', 'Bob'])).toBe(
      'Alice and Bob are typing…',
    );
  });

  it('comma-separates three typists', () => {
    expect(formatTypingNotice(['Alice', 'Bob', 'Carol'])).toBe(
      'Alice, Bob and Carol are typing…',
    );
  });

  it('summarises four or more typists', () => {
    expect(formatTypingNotice(['Alice', 'Bob', 'Carol', 'Dave'])).toBe(
      'Several people are typing…',
    );
  });

  it('keeps the refresh interval below the server timeout', () => {
    // Refreshing after the flag lapses would let the indicator flicker off mid-compose.
    expect(TYPING_REFRESH_MS).toBeLessThan(TYPING_TIMEOUT_MS);
  });
});
