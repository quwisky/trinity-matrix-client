import { describe, expect, it } from 'vitest';
import {
  filterRoomLibraryItems,
  matchesRoomFilter,
  normalizeRoomFilter,
} from './room-filter';

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
    expect(matchesRoomFilter('core-dev', normalizeRoomFilter('dev'))).toBe(
      true,
    );
  });

  it('ignores case and accents in both directions', () => {
    expect(
      matchesRoomFilter('Café Münster', normalizeRoomFilter('CAFE MÜN')),
    ).toBe(true);
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

describe('filterRoomLibraryItems', () => {
  const rooms = [{ name: 'Core Dev' }, { name: 'Design Review' }] as const;

  it('preserves the source identity when no filter is active', () => {
    expect(filterRoomLibraryItems(rooms, '  ')).toBe(rooms);
  });

  it('owns the named-row filtering projection', () => {
    expect(filterRoomLibraryItems(rooms, 'dev')).toEqual([
      { name: 'Core Dev' },
    ]);
  });
});
