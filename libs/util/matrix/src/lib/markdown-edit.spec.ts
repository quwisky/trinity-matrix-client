import { describe, expect, it } from 'vitest';
import {
  applyFormat,
  detectFormat,
  continueList,
  type FormatAction,
  type EditResult,
} from './markdown-edit';

/**
 * Render a result as text with the selection marked, so a failure reads as the string the
 * user would see rather than three separate numbers. `|` is a caret, `[…]` a range.
 */
function show({ text, selectionStart, selectionEnd }: EditResult): string {
  return selectionStart === selectionEnd
    ? `${text.slice(0, selectionStart)}|${text.slice(selectionStart)}`
    : `${text.slice(0, selectionStart)}[${text.slice(selectionStart, selectionEnd)}]${text.slice(selectionEnd)}`;
}

/**
 * Apply an action to `input`, where `[…]` marks the selection and `|` an empty one.
 *
 * Strips the FIRST bracket pair, so it cannot express a fixture whose own text contains
 * brackets — a markdown link, or a task box. `'- [ ] [one]'` silently decodes to `'-   [one]'`
 * with a single space selected, which is how one invariant fixture spent a while covering
 * nothing. Where the text has brackets of its own, pass explicit offsets instead, as the
 * contract block at the bottom of this file does.
 */
function at(input: string, action: FormatAction): string {
  const caret = input.indexOf('|');
  if (caret !== -1) {
    return show(applyFormat(input.replace('|', ''), caret, caret, action));
  }
  const start = input.indexOf('[');
  const end = input.indexOf(']') - 1;
  return show(
    applyFormat(input.replace('[', '').replace(']', ''), start, end, action),
  );
}

describe('applyFormat — inline', () => {
  it.each([
    ['bold', '**'],
    ['italic', '*'],
    ['strike', '~~'],
    ['code', '`'],
  ] as const)('wraps a selection in %s markers', (action, marker) => {
    expect(at('say [hello] there', action)).toBe(
      `say ${marker}[hello]${marker} there`,
    );
  });

  it('leaves the caret between the markers when nothing is selected', () => {
    expect(at('say |', 'bold')).toBe('say **|**');
  });

  it('keeps the selection over the wrapped words, so actions compose', () => {
    // Bold then italic on the same words must give ***hello***, not a lost selection.
    const bold = applyFormat('say hello', 4, 9, 'bold');
    const both = applyFormat(
      bold.text,
      bold.selectionStart,
      bold.selectionEnd,
      'italic',
    );

    expect(both.text).toBe('say ***hello***');
  });

  it('unwraps when the markers sit just outside the selection', () => {
    // The user selected the word, not the asterisks.
    expect(at('say **[hello]** there', 'bold')).toBe('say [hello] there');
  });

  it('unwraps when the markers sit inside the selection', () => {
    // The user selected the markup too.
    expect(at('say [**hello**] there', 'bold')).toBe('say [hello] there');
  });

  it('does not mistake a bold marker for an italic one', () => {
    // `*` is a prefix of `**`, so a naive check would unwrap the wrong thing.
    expect(at('say **[hello]** there', 'italic')).toBe(
      'say ***[hello]*** there',
    );
  });
});

describe('applyFormat — block', () => {
  it.each([
    ['quote', '> '],
    ['list', '- '],
  ] as const)(
    'prefixes every line the selection touches with %s',
    (action, prefix) => {
      const result = applyFormat('one\ntwo\nthree', 1, 6, action);

      expect(result.text).toBe(`${prefix}one\n${prefix}two\nthree`);
    },
  );

  it('prefixes the whole line even when only part of it is selected', () => {
    // A quote applies to a line; selecting its middle still means "quote this line".
    expect(applyFormat('hello there', 6, 9, 'quote').text).toBe(
      '> hello there',
    );
  });

  it('strips the prefix when every line already carries it', () => {
    expect(applyFormat('- one\n- two', 0, 11, 'list').text).toBe('one\ntwo');
  });

  it('brings every line to the marker when only some carry it', () => {
    // Not "prefix everything again": the line that already is a bullet stays one.
    expect(applyFormat('- one\ntwo', 0, 9, 'list').text).toBe('- one\n- two');
  });

  it('swaps one list marker for another instead of stacking them', () => {
    // Turning a bullet list into a checklist is the obvious flow, and prefixing blindly
    // produced `- [ ] - a`, which renders as a nested bullet.
    expect(applyFormat('- a', 0, 3, 'tasklist').text).toBe('- [ ] a');
    expect(applyFormat('1. a', 0, 4, 'tasklist').text).toBe('- [ ] a');
    expect(applyFormat('1. a', 0, 4, 'list').text).toBe('- a');
    expect(applyFormat('- [ ] a', 0, 7, 'list').text).toBe('- a');
    expect(applyFormat('  - a', 0, 5, 'tasklist').text).toBe('  - [ ] a');
  });

  it('toggles a marker off when every line already has that exact one', () => {
    expect(applyFormat('- [x] done', 0, 10, 'tasklist').text).toBe('done');
    expect(applyFormat('- a\n- b', 0, 7, 'list').text).toBe('a\nb');
  });

  it('keeps a quote separate from the list marker, as markdown does', () => {
    // `> - item` is a list inside a quote, not a competing marker — quoting must not eat it.
    expect(applyFormat('- a', 0, 3, 'quote').text).toBe('> - a');
    expect(applyFormat('> - a', 0, 5, 'quote').text).toBe('- a');
  });

  it('prefixes a task item, and strips it again', () => {
    expect(at('milk|', 'tasklist')).toBe('- [ ] milk|');
    expect(applyFormat('- [ ] milk', 6, 10, 'tasklist').text).toBe('milk');
  });

  it.each([
    ['quote', '> '],
    ['list', '- '],
    ['tasklist', '- [ ] '],
  ] as const)('starts a %s on an empty composer', (action, prefix) => {
    // There is nothing to toggle off, so the blank line takes the prefix — clicking the
    // button on an empty composer has to start the block, not do nothing.
    expect(at('|', action)).toBe(`${prefix}|`);
  });

  it('prefixes the first line when the draft opens with a blank one', () => {
    // Caret at 0 with a leading newline: searching backwards from index 0 matched the
    // newline AT index 0, so the block was read one line down and the two slices overlapped,
    // duplicating the break. Reachable with Shift+Enter on an empty composer, then Home.
    expect(applyFormat('\nabc', 0, 0, 'list')).toEqual({
      text: '- \nabc',
      selectionStart: 2,
      selectionEnd: 2,
    });
    expect(applyFormat('\nabc', 0, 0, 'quote').text).toBe('> \nabc');
  });

  it('starts a block on a blank line inside a draft', () => {
    expect(applyFormat('foo\n\nbar', 4, 4, 'quote')).toEqual({
      text: 'foo\n> \nbar',
      selectionStart: 6,
      selectionEnd: 6,
    });
  });

  it('never returns a selection that runs backwards', () => {
    // A start past the end is silently collapsed by the browser, hiding the miscount.
    for (const [text, start, end] of [
      ['', 0, 0],
      ['foo\n\nbar', 4, 4],
      ['a\n\nfoo', 2, 6],
    ] as const) {
      const result = applyFormat(text, start, end, 'quote');
      expect(
        result.selectionEnd,
        JSON.stringify(result),
      ).toBeGreaterThanOrEqual(result.selectionStart);
    }
  });

  it('leaves the caret off a prefix it did not insert on that line', () => {
    // The first touched line is blank and keeps its width, so the caret must not shift.
    expect(applyFormat('a\n\nfoo', 2, 6, 'quote')).toEqual({
      text: 'a\n\n> foo',
      selectionStart: 2,
      selectionEnd: 8,
    });
  });
});

describe('applyFormat — code block', () => {
  it('fences the selection on its own lines', () => {
    expect(applyFormat('x = 1', 0, 5, 'codeblock').text).toBe(
      '```\nx = 1\n```',
    );
  });

  it('does not add a blank line where one already exists', () => {
    expect(applyFormat('note:\nx = 1', 6, 11, 'codeblock').text).toBe(
      'note:\n```\nx = 1\n```',
    );
  });

  it('leaves the caret inside the fence when nothing is selected', () => {
    expect(show(applyFormat('', 0, 0, 'codeblock'))).toBe('```\n|\n```');
  });
});

describe('applyFormat — link', () => {
  it('makes the selection the link text and puts the caret in the url', () => {
    expect(at('see [the docs] now', 'link')).toBe('see [the docs](|) now');
  });

  it('puts the caret in the link text when nothing is selected', () => {
    expect(at('see |', 'link')).toBe('see [|]()');
  });
});

describe('continueList', () => {
  const after = (input: string) => {
    const caret = input.indexOf('|');
    const result = continueList(input.replace('|', ''), caret);
    return result === null ? null : show(result);
  };

  it.each([
    ['a bullet', '- one|', '- one\n- |'],
    ['an asterisk bullet', '* one|', '* one\n* |'],
    ['a quote', '> one|', '> one\n> |'],
  ])('continues %s', (_label, input, expected) => {
    expect(after(input)).toBe(expected);
  });

  it('increments an ordered marker', () => {
    expect(after('1. one|')).toBe('1. one\n2. |');
    expect(after('9) nine|')).toBe('9) nine\n10) |');
  });

  it('carries the indentation of a nested item', () => {
    expect(after('  - one|')).toBe('  - one\n  - |');
  });

  it('ends the list when the item is empty', () => {
    // The second Shift+Enter on an empty item removes the marker rather than adding another.
    expect(after('- one\n- |')).toBe('- one\n|');
  });

  it('returns null on a line with no marker, so the caller inserts a plain newline', () => {
    expect(continueList('just text', 9)).toBeNull();
    expect(continueList('', 0)).toBeNull();
  });

  it('reads the line the caret is on, not the last line', () => {
    expect(after('- one|\n- two')).toBe('- one\n- |\n- two');
  });

  it('is not fooled by a hyphen mid-line', () => {
    expect(continueList('well-known|'.replace('|', ''), 10)).toBeNull();
  });

  it('continues a task item as a fresh unchecked one', () => {
    // Carrying `[x]` across would tick the new item before it exists.
    expect(after('- [ ] milk|')).toBe('- [ ] milk\n- [ ] |');
    expect(after('- [x] milk|')).toBe('- [x] milk\n- [ ] |');
    expect(after('  - [X] nested|')).toBe('  - [X] nested\n  - [ ] |');
  });

  it('ends the list on an empty task item', () => {
    expect(after('- [ ] milk\n- [ ] |')).toBe('- [ ] milk\n|');
  });

  it('splits the item when the caret sits inside it', () => {
    // "Empty item" is a property of the whole line, not of the text before the caret —
    // reading only the latter deleted the marker instead of continuing the list.
    expect(after('- |milk')).toBe('- \n- |milk');
    expect(after('  - |nested')).toBe('  - \n  - |nested');
    expect(after('> |quoted')).toBe('> \n> |quoted');
  });

  it('leaves a caret inside the marker to the caller', () => {
    // Splitting here would tear the marker in half; a plain newline is the safe reading.
    expect(continueList('- milk', 1)).toBeNull();
    expect(continueList('1. one', 2)).toBeNull();
  });

  it('ends the list from a caret anywhere in an empty item', () => {
    expect(after('- one\n- | ')).toBe('- one\n|');
  });
});

describe('detectFormat', () => {
  /** Detect against `input`, where `[…]` marks the selection and `|` an empty one. */
  function marks(input: string): FormatAction[] {
    const caret = input.indexOf('|');
    if (caret !== -1) {
      return detectFormat(input.replace('|', ''), caret, caret);
    }
    const start = input.indexOf('[');
    const end = input.indexOf(']') - 1;
    return detectFormat(
      input.replace('[', '').replace(']', ''),
      start,
      end,
    ).sort();
  }

  it.each([
    ['bold', '**'],
    ['italic', '*'],
    ['strike', '~~'],
    ['code', '`'],
  ] as const)(
    'reports %s when the markers sit outside the selection',
    (action, marker) => {
      expect(marks(`say ${marker}[hello]${marker} there`)).toContain(action);
    },
  );

  it.each([
    ['bold', '**'],
    ['italic', '*'],
    ['strike', '~~'],
    ['code', '`'],
  ] as const)(
    'reports %s when the selection contains the markers',
    (action, marker) => {
      expect(marks(`say [${marker}hello${marker}] there`)).toContain(action);
    },
  );

  it('does not read the inner asterisk of bold as italic', () => {
    // The prefix trap `applyInline` documents: `*` is a prefix of `**`, so a prefix test
    // would report italic here and pressing it would strip a bold marker.
    expect(marks('say **[hello]** there')).toEqual(['bold']);
  });

  it('reports nothing for unformatted text', () => {
    expect(marks('say [hello] there')).toEqual([]);
  });

  it.each([
    ['quote', '> one'],
    ['list', '- one'],
    ['tasklist', '- [ ] one'],
  ] as const)(
    'reports %s from the line the selection touches',
    (action, line) => {
      // The middle of the line, not the marker — a block action is about the line.
      const at = line.indexOf('one');
      expect(detectFormat(line, at + 1, at + 2)).toContain(action);
    },
  );

  it('reports a block action only when EVERY line carries it', () => {
    const text = '> one\ntwo';
    expect(detectFormat(text, 0, text.length)).not.toContain('quote');
    expect(detectFormat('> one\n> two', 0, 10)).toContain('quote');
  });

  it('keeps a task item distinct from a plain bullet', () => {
    // `carries` treats the three kinds of list item as different things, and detection has
    // to agree or Bulleted list reads as pressed on a task item it would convert.
    expect(detectFormat('- [ ] one', 7, 8)).toEqual(['tasklist']);
    expect(detectFormat('- one', 3, 4)).toEqual(['list']);
  });

  it('never reports link or codeblock, which cannot unwrap', () => {
    expect(marks('[say hello](https://x.test)')).not.toContain('link');
    expect(detectFormat('```\nhello\n```', 4, 9)).not.toContain('codeblock');
  });

  it('clamps an out-of-range selection to the text', () => {
    // Same clamp `applyFormat` opens with, so a stale selection arriving from the textarea
    // reads as the nearest real one rather than throwing or reporting nonsense. Clamped,
    // `(-5, 999)` over `**hi**` is the whole string — which really is bold, from the inside.
    expect(detectFormat('**hi**', -5, 999)).toEqual(
      detectFormat('**hi**', 0, 6),
    );
    expect(detectFormat('**hi**', -5, 999)).toEqual(['bold']);
    // And a selection entirely past the end is empty rather than out of bounds.
    expect(detectFormat('**hi**', 999, 1000)).toEqual([]);
  });

  describe('agrees with applyFormat, which is the whole contract', () => {
    // Explicit offsets, NOT the `[…]` helper the tests above use. That helper strips the
    // first bracket PAIR, which in `- [ ] one` is the markdown task box rather than the
    // selection marker — the fixture silently decoded to `-   [one]` with a single space
    // selected, and passed for all nine actions because both sides agreed on nonsense. The
    // one case that most needed covering was the one covering nothing.
    const CASES: [text: string, start: number, end: number][] = [
      ['say hello there', 4, 9],
      ['say **hello** there', 6, 11],
      ['say **hello** there', 4, 13],
      ['say *hello* there', 5, 10],
      ['say ~~hello~~ there', 6, 11],
      ['say `hello` there', 5, 10],
      ['say ***hello*** there', 7, 12],
      ['> one', 2, 5],
      ['- one', 2, 5],
      ['- [ ] one', 6, 9],
      ['1. one', 3, 6],
      ['> - [ ] a', 6, 7],
      ['one', 0, 3],
      ['', 0, 0],
    ];
    const ACTIONS: FormatAction[] = [
      'bold',
      'italic',
      'strike',
      'code',
      'quote',
      'list',
      'tasklist',
      'link',
      'codeblock',
    ];

    it.each(ACTIONS)('a lit %s unlights when it is applied', (action) => {
      // The property `aria-pressed` actually promises, and the only one true in every case:
      // press a button that reads as pressed and it stops reading as pressed.
      //
      // NOT the converse. Pressing an UNLIT toggle usually lights it, but not always, and the
      // exceptions are deliberate: `italic` over `**hello**` nests to `***hello***`, which the
      // exact-run-length rule then reports as neither bold nor italic. And NOT "applying makes
      // the text shorter", which an earlier version of this test used as a proxy for removal —
      // `list` on `- [ ] one` gives `- one`, shorter without removing anything, because
      // `applyLinePrefix` CONVERTS between kinds of list. Add, remove, convert: three
      // outcomes, and only the middle one is ever reported.
      for (const [text, start, end] of CASES) {
        if (!detectFormat(text, start, end).includes(action)) {
          continue;
        }
        const applied = applyFormat(text, start, end, action);
        expect(
          detectFormat(
            applied.text,
            applied.selectionStart,
            applied.selectionEnd,
          ),
          `${action} on ${JSON.stringify(text)} read as pressed, and still does after applying it (${JSON.stringify(applied.text)})`,
        ).not.toContain(action);
      }
    });

    it('reports something to unlight, so the case above is not vacuous', () => {
      // A guard on the guard: the loop skips every unreported pair, so a `detectFormat` that
      // reported nothing at all would pass all nine cases in silence.
      const lit = CASES.flatMap(([text, start, end]) =>
        detectFormat(text, start, end),
      );
      expect(lit.length).toBeGreaterThanOrEqual(9);
      expect(new Set(lit)).toEqual(
        new Set([
          'bold',
          'italic',
          'strike',
          'code',
          'quote',
          'list',
          'tasklist',
        ]),
      );
    });

    it('never reports link or codeblock, which only ever insert', () => {
      for (const [text, start, end] of CASES) {
        const reported = detectFormat(text, start, end);
        expect(reported).not.toContain('link');
        expect(reported).not.toContain('codeblock');
      }
    });
  });
});
