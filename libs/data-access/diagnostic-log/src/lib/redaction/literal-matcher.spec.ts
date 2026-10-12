import { describe, expect, it } from 'vitest';
import { runToEnd } from '../report/run-in-slices';
import { LiteralMatcher } from './literal-matcher';

function mark(literals: readonly string[], text: string): string {
  return runToEnd(LiteralMatcher.build(literals)).replace(
    text,
    (match) => `[${match}]`,
  );
}

describe('LiteralMatcher', () => {
  it('takes the longest literal at a position', () => {
    expect(
      mark(['Team', 'Team Alpha Ops', 'Team Alpha'], 'Team Alpha Ops!'),
    ).toBe('[Team Alpha Ops]!');
  });

  it('takes the leftmost of overlapping literals, then continues after it', () => {
    expect(mark(['xy', 'ybc', 'bc'], 'xybc')).toBe('[xy][bc]');
    expect(mark(['abcd', 'bc'], 'abcd abc')).toBe('[abcd] a[bc]');
  });

  it('matches by exact substring, case and all', () => {
    expect(mark(['Ann'], 'Ann, ann, Annabel')).toBe('[Ann], ann, [Ann]abel');
  });

  it('matches literals outside the Basic Multilingual Plane', () => {
    expect(mark(['开发团队', '🌱 Garden'], '进入开发团队 and 🌱 Garden')).toBe(
      '进入[开发团队] and [🌱 Garden]',
    );
  });

  it('returns the text unchanged without literals or matches', () => {
    expect(mark([], 'nothing')).toBe('nothing');
    expect(mark(['absent'], 'nothing')).toBe('nothing');
    expect(mark(['x'], '')).toBe('');
  });

  it('pauses while it indexes a large set of literals', () => {
    const literals = Array.from(
      { length: 2_000 },
      (_, n) => `name number ${n}`,
    );
    const build = LiteralMatcher.build(literals);
    let pauses = 0;
    let step = build.next();
    while (!step.done) {
      pauses += 1;
      step = build.next();
    }

    expect(pauses).toBeGreaterThan(5);
    expect(step.value.replace('see name number 1999!', (m) => `[${m}]`)).toBe(
      'see [name number 1999]!',
    );
  });

  it('scans a shorter line after a longer one without stale matches', () => {
    const matcher = runToEnd(LiteralMatcher.build(['abc']));
    expect(matcher.replace('zzzzzzabc', (m) => `[${m}]`)).toBe('zzzzzz[abc]');
    expect(matcher.replace('ab', (m) => `[${m}]`)).toBe('ab');
  });
});
