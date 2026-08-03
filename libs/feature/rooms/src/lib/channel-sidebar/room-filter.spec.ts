import { describe, expect, it } from 'vitest';
import { matchesRoomFilter, normalizeRoomFilter } from './room-filter';

describe('normalizeRoomFilter', () => {
  it('treats a blank query as no filter', () => {
    expect(normalizeRoomFilter('')).toBe('');
    expect(normalizeRoomFilter('   ')).toBe('');
  });

  it('folds case and accents so the match is insensitive to both', () => {
    expect(normalizeRoomFilter('  CAFÉ ')).toBe('cafe');
  });
});

describe('matchesRoomFilter', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesRoomFilter('anything', '')).toBe(true);
  });

  it('matches a substring, not just a prefix', () => {
    // Typing "dev" to find "core-dev" is the common case; a prefix match would miss it.
    expect(matchesRoomFilter('core-dev', normalizeRoomFilter('dev'))).toBe(
      true,
    );
  });

  it('ignores case in both directions', () => {
    expect(
      matchesRoomFilter('Design Review', normalizeRoomFilter('DESIGN')),
    ).toBe(true);
    expect(
      matchesRoomFilter('DESIGN REVIEW', normalizeRoomFilter('design')),
    ).toBe(true);
  });

  it('ignores accents, so an unaccented query finds an accented room', () => {
    expect(matchesRoomFilter('Café Münster', normalizeRoomFilter('cafe'))).toBe(
      true,
    );
    expect(
      matchesRoomFilter('Café Münster', normalizeRoomFilter('munster')),
    ).toBe(true);
  });

  it('still matches when the query itself carries the accents', () => {
    expect(matchesRoomFilter('Cafe Munster', normalizeRoomFilter('café'))).toBe(
      true,
    );
  });

  it('rejects a name that does not contain the query', () => {
    expect(matchesRoomFilter('Design Review', normalizeRoomFilter('ops'))).toBe(
      false,
    );
  });
});
