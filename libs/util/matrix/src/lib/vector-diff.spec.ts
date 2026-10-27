import { describe, expect, it } from 'vitest';
import { applyVectorDiffs, type VectorDiff } from './vector-diff';

describe('applyVectorDiffs', () => {
  it('applies every op in order', () => {
    const diffs: VectorDiff<string>[] = [
      { op: 'pushFront', value: 'z' },
      { op: 'remove', index: 2 },
      { op: 'set', index: 0, value: 'y' },
      { op: 'insert', index: 1, value: 'x' },
      { op: 'truncate', length: 3 },
      { op: 'append', values: ['q'] },
      { op: 'popBack' },
      { op: 'pushBack', value: 'w' },
      { op: 'popFront' },
    ];
    expect(applyVectorDiffs(['a', 'b', 'c'], diffs)).toEqual(['x', 'a', 'w']);
  });

  it('reset replaces the list', () => {
    expect(
      applyVectorDiffs(['a'], [{ op: 'reset', values: ['b', 'c'] }]),
    ).toEqual(['b', 'c']);
  });

  it('clear empties it', () => {
    expect(applyVectorDiffs(['a', 'b'], [{ op: 'clear' }])).toEqual([]);
  });

  it('throws on an out-of-range index', () => {
    const list = ['a'];
    expect(() => applyVectorDiffs(list, [{ op: 'remove', index: 1 }])).toThrow(
      RangeError,
    );
    expect(() =>
      applyVectorDiffs(list, [{ op: 'set', index: -1, value: 'x' }]),
    ).toThrow(RangeError);
    expect(() =>
      applyVectorDiffs(list, [{ op: 'insert', index: 2, value: 'x' }]),
    ).toThrow(RangeError);
    expect(list).toEqual(['a']);
  });

  it('returns the same array when diffs is empty', () => {
    const list = ['a'];
    expect(applyVectorDiffs(list, [])).toBe(list);
  });
});
