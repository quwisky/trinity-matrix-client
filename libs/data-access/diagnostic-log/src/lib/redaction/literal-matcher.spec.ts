import { describe, expect, it } from 'vitest';
import { runToEnd } from '../report/run-in-slices';
import { LiteralMatcher, type MatcherLiteral } from './literal-matcher';

function matcher(
  literals: readonly string[],
  edges: Pick<MatcherLiteral, 'checkStart' | 'checkEnd'> = {
    checkStart: true,
    checkEnd: true,
  },
): LiteralMatcher {
  return runToEnd(
    LiteralMatcher.build(literals.map((text) => ({ text, ...edges }))),
  );
}

const bracket = (match: string): string => `[${match}]`;

/** Whole-word matching, as names use it. */
function mark(literals: readonly string[], text: string): string {
  return matcher(literals).replace(text, bracket);
}

/** Plain substring matching, no word boundaries. */
function markAnywhere(literals: readonly string[], text: string): string {
  return matcher(literals, { checkStart: false, checkEnd: false }).replace(
    text,
    bracket,
  );
}

describe('LiteralMatcher', () => {
  it('takes the longest literal at a position', () => {
    expect(
      mark(['Team', 'Team Alpha Ops', 'Team Alpha'], 'Team Alpha Ops!'),
    ).toBe('[Team Alpha Ops]!');
  });

  it('takes the leftmost of overlapping literals, then continues after it', () => {
    expect(markAnywhere(['xy', 'ybc', 'bc'], 'xybc')).toBe('[xy][bc]');
    expect(markAnywhere(['abcd', 'bc'], 'abcd abc')).toBe('[abcd] a[bc]');
  });

  it('matches whole words only, case and all', () => {
    expect(mark(['Ann'], 'Ann, ann, Annabel, JoAnn, Ann_x')).toBe(
      '[Ann], ann, Annabel, JoAnn, Ann_x',
    );
  });

  it('checks a boundary only where the literal starts or ends with a letter or digit', () => {
    expect(mark(['(Ops)', '-dev'], 'x(Ops)y a-dev')).toBe('x[(Ops)]y a[-dev]');
  });

  it('falls back to a shorter literal when a longer one ends inside a word', () => {
    expect(mark(['Alpha', 'Alpha Bet', 'Alpha Be'], 'Alpha Better')).toBe(
      '[Alpha] Better',
    );
  });

  it('checks only the edges a literal asks for', () => {
    const chunks = runToEnd(
      LiteralMatcher.build([
        { text: 'Long', checkStart: true, checkEnd: false },
        { text: 'topic', checkStart: false, checkEnd: true },
      ]),
    );

    expect(chunks.replace('Longtopic xLong topicx', bracket)).toBe(
      '[Long][topic] xLong topicx',
    );
  });

  it('exempts scripts written without spaces from word boundaries', () => {
    expect(mark(['开发团队', 'ไทย'], '进入开发团队了 ภาษาไทยดี')).toBe(
      '进入[开发团队]了 ภาษา[ไทย]ดี',
    );
  });

  it('matches literals outside the Basic Multilingual Plane', () => {
    expect(markAnywhere(['🌱 Garden'], 'a 🌱 Garden')).toBe('a [🌱 Garden]');
  });

  it('never matches across the edge of a protected span, but may contain one', () => {
    const text = '@me:server1 Ops at server2 erver';
    const protectedSpans = [
      [0, 11],
      [19, 26],
    ] as const;

    expect(
      matcher(['erver', 'Ops at server2', 'me:s']).replace(
        text,
        bracket,
        protectedSpans,
      ),
    ).toBe('@me:server1 [Ops at server2] [erver]');
  });

  it('tells the replacement where each match starts', () => {
    const starts: number[] = [];
    matcher(['Ann']).replace('Ann and Ann', (match, start) => {
      starts.push(start);
      return match;
    });

    expect(starts).toEqual([0, 8]);
  });

  it('returns the text unchanged without literals or matches', () => {
    expect(mark([], 'nothing')).toBe('nothing');
    expect(mark(['absent'], 'nothing')).toBe('nothing');
    expect(mark(['xyz'], '')).toBe('');
  });

  it('pauses while it indexes a large set of literals', () => {
    const literals = Array.from(
      { length: 2_000 },
      (_, n) => `name number ${n}`,
    );
    const build = LiteralMatcher.build(
      literals.map((text) => ({ text, checkStart: true, checkEnd: true })),
    );
    let pauses = 0;
    let step = build.next();
    while (!step.done) {
      pauses += 1;
      step = build.next();
    }

    expect(pauses).toBeGreaterThan(5);
    expect(step.value.replace('see name number 1999!', bracket)).toBe(
      'see [name number 1999]!',
    );
  });

  it('scans a shorter line after a longer one without stale matches', () => {
    const abc = matcher(['abc']);
    expect(abc.replace('zzz abc', bracket)).toBe('zzz [abc]');
    expect(abc.replace('ab', bracket)).toBe('ab');
  });
});
