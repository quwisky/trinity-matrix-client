import { afterEach, describe, expect, it, vi } from 'vitest';
import { annotateRevision, diffTokens } from './edit-history-diff';
import { type MessageRevisionView } from './edit-history';

function revision(
  over: Partial<MessageRevisionView> = {},
): MessageRevisionView {
  return {
    id: '$1',
    timestamp: 1000,
    body: '',
    html: null,
    kind: 'text',
    isOwn: true,
    ...over,
  };
}

/** Parse annotated HTML so assertions can ask about structure, not string shape. */
function render(html: string | null): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html ?? '';
  return host;
}

/** A plain-text revision (what a message with no formatting projects to). */
const plain = (body: string, id = '$p') => revision({ id, body });
/** A formatted revision — `body` is the text fallback, `html` what renders. */
const rich = (body: string, html: string, id = '$r') =>
  revision({ id, body, html });

describe('diffTokens', () => {
  it('marks an inserted word without disturbing what stayed', () => {
    const ops = diffTokens('the cat sat', 'the black cat sat');

    expect(
      ops.filter((op) => op.kind === 'add').map((op) => op.text.trim()),
    ).toEqual(['black']);
    expect(ops.some((op) => op.kind === 'remove')).toBe(false);
    // Everything still present is reported as unchanged, in order.
    expect(
      ops
        .filter((op) => op.kind === 'same')
        .map((op) => op.text)
        .join(''),
    ).toContain('the ');
  });

  it('marks a removed word', () => {
    const ops = diffTokens('the black cat sat', 'the cat sat');

    expect(
      ops.filter((op) => op.kind === 'remove').map((op) => op.text.trim()),
    ).toEqual(['black']);
    expect(ops.some((op) => op.kind === 'add')).toBe(false);
  });

  it('reads a replacement as the old word out and the new word in', () => {
    const ops = diffTokens('meet at noon', 'meet at midnight');

    expect(
      ops.filter((op) => op.kind === 'remove').map((op) => op.text),
    ).toEqual(['noon']);
    expect(ops.filter((op) => op.kind === 'add').map((op) => op.text)).toEqual([
      'midnight',
    ]);
  });

  it('reassembles losslessly — the ops rebuild both versions exactly', () => {
    const before = 'ship it on Friday, not Thursday!';
    const after = 'ship it on Thursday, please';
    const ops = diffTokens(before, after);

    const rebuiltBefore = ops
      .filter((op) => op.kind !== 'add')
      .map((op) => op.text)
      .join('');
    const rebuiltAfter = ops
      .filter((op) => op.kind !== 'remove')
      .map((op) => op.text)
      .join('');
    expect(rebuiltBefore).toBe(before);
    expect(rebuiltAfter).toBe(after);
  });

  // Precomposed vs decomposed forms are different strings for ===; without normalizing,
  // the same word typed on two platforms would read as an edit.
  it('does not report a change between the two unicode spellings of a word', () => {
    const ops = diffTokens('café opens at 8', 'café opens at 8');

    expect(ops.every((op) => op.kind === 'same')).toBe(true);
  });

  it('keeps a family emoji whole rather than splitting its code points', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const ops = diffTokens(`hi ${family}`, 'hi');

    const removed = ops
      .filter((op) => op.kind === 'remove')
      .map((op) => op.text)
      .join('');
    expect(removed).toContain(family);
    expect(removed).not.toMatch(/^\u{1F468}$/u);
  });

  // The sharpest edge of diffing characters: 🎉 and 🎊 are adjacent code points, so as
  // UTF-16 they SHARE a high surrogate and differ only in the low one. A diff that works
  // on code units happily reports "keep \uD83C, swap \uDF89 for \uDF8A" — which is two
  // lone surrogates, i.e. text that cannot be rendered. Every op must stand alone as
  // valid text.
  it('never cuts a diff boundary inside an astral character', () => {
    const ops = diffTokens('party 🎉 time', 'party 🎊 time');

    for (const op of ops) {
      // A lone high surrogate not followed by a low one, or vice versa.
      expect(op.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(op.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(ops.find((op) => op.kind === 'add')?.text).toBe('🎊');
    expect(ops.find((op) => op.kind === 'remove')?.text).toBe('🎉');
  });

  it('marks only the character that changed in text with no word breaks', () => {
    const ops = diffTokens('今天天气很好', '今天天气不好');

    expect(ops.filter((op) => op.kind === 'add').map((op) => op.text)).toEqual([
      '不',
    ]);
    expect(
      ops.filter((op) => op.kind === 'remove').map((op) => op.text),
    ).toEqual(['很']);
  });

  it('marks a case change as the one letter it is', () => {
    const ops = diffTokens('see you monday', 'see you Monday');

    expect(ops.filter((op) => op.kind === 'add').map((op) => op.text)).toEqual([
      'M',
    ]);
    expect(
      ops.filter((op) => op.kind === 'remove').map((op) => op.text),
    ).toEqual(['m']);
  });

  it('marks added punctuation without touching the words', () => {
    const ops = diffTokens('are you sure', 'are you sure?');

    expect(ops.filter((op) => op.kind === 'add').map((op) => op.text)).toEqual([
      '?',
    ]);
    expect(ops.some((op) => op.kind === 'remove')).toBe(false);
  });

  // Two words sharing letters in the same order are where a raw character diff turns to
  // confetti: it matches the stray "it" in the middle and reports
  // keep "the comm" / add "un" / keep "it" / remove "tee" / add "y" — five ops chopping
  // one word into alternating slivers. cleanupSemantic is what collapses that back into
  // "committee became community", and this is the test that notices if it goes away.
  it('reports one coherent change per word, not a trail of slivers', () => {
    const ops = diffTokens('the committee meeting', 'the community meeting');

    expect(ops.filter((op) => op.kind === 'add')).toHaveLength(1);
    expect(ops.filter((op) => op.kind === 'remove')).toHaveLength(1);
    // Nothing unchanged is stranded in the middle of the changed word.
    expect(ops.map((op) => op.kind)).toEqual(['same', 'remove', 'add', 'same']);
  });

  it('keeps line breaks in a multi-line message', () => {
    const ops = diffTokens('one\ntwo\nthree', 'one\ntwo\nfour');

    expect(
      ops
        .filter((op) => op.kind !== 'add')
        .map((op) => op.text)
        .join(''),
    ).toBe('one\ntwo\nthree');
    expect(ops.filter((op) => op.kind === 'same')[0].text).toContain('\n');
  });

  it('does not highlight a lone run of whitespace', () => {
    const ops = diffTokens('one two', 'one  two');

    expect(ops.every((op) => op.kind === 'same')).toBe(true);
  });

  // A highlight that starts a space early reads as a stray gap before the word.
  it('keeps the space out of an added word', () => {
    const ops = diffTokens('meet Monday', 'meet Monday morning');

    const added = ops.filter((op) => op.kind === 'add').map((op) => op.text);
    expect(added).toEqual(['morning']);
    expect(added[0]).not.toMatch(/^\s/);
  });

  // The point of diffing characters rather than words: a typo fix marks the letters that
  // changed instead of striking the whole word and re-adding it.
  it('marks the letters that changed, not the whole word', () => {
    const ops = diffTokens('meet on Firday', 'meet on Friday');

    const added = ops
      .filter((op) => op.kind === 'add')
      .map((op) => op.text)
      .join('');
    const removed = ops
      .filter((op) => op.kind === 'remove')
      .map((op) => op.text)
      .join('');
    expect(added.length).toBeLessThan('Friday'.length);
    expect(removed.length).toBeLessThan('Firday'.length);
    // The unchanged letters are still reported as unchanged.
    expect(
      ops
        .filter((op) => op.kind === 'same')
        .map((op) => op.text)
        .join(''),
    ).toContain('meet on F');
  });

  // Message length is bounded only by the event size limit, so an expensive-to-compare
  // edit is reachable by anyone. The library's deadline is what stops it running on; past
  // it the answer gets blunter, never wrong.
  it('stays quick on a pair with nothing in common', () => {
    const before = Array.from({ length: 900 }, (_, i) => `a${i}`).join(' ');
    const after = Array.from({ length: 900 }, (_, i) => `b${i}`).join(' ');

    const started = performance.now();
    const ops = diffTokens(before, after);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
    // Whatever granularity it settled on, the ops still describe both versions exactly.
    expect(
      ops
        .filter((op) => op.kind !== 'add')
        .map((op) => op.text)
        .join(''),
    ).toBe(before);
    expect(
      ops
        .filter((op) => op.kind !== 'remove')
        .map((op) => op.text)
        .join(''),
    ).toBe(after);
  });
});

describe('annotateRevision', () => {
  afterEach(() => vi.restoreAllMocks());

  it('wraps what the edit added and puts back what it removed', () => {
    const html = annotateRevision(
      plain('meet at noon'),
      plain('meet at midnight'),
    );

    expect(html).toContain('<ins class="diff-ins">midnight</ins>');
    expect(html).toContain('<del class="diff-del">noon</del>');
  });

  it('keeps the formatting of the version it annotates', () => {
    const before = rich('ship on Friday', 'ship on <strong>Friday</strong>');
    const after = rich('ship on Monday', 'ship on <strong>Monday</strong>');

    const rendered = render(annotateRevision(before, after));

    // The highlight lands INSIDE the bold run, so the changed letters stay bold AND
    // marked. Character-level: "Friday" → "Monday" shares "day", so only the first three
    // letters are marked — that is the granularity, not a bug.
    expect(rendered.querySelector('strong ins.diff-ins')?.textContent).toBe(
      'Mon',
    );
    expect(rendered.querySelector('del.diff-del')?.textContent).toBe('Fri');
    // The bold run still reads as the whole word.
    expect(rendered.querySelector('strong')?.textContent).toContain('day');
  });

  it('leaves untouched text exactly as the revision rendered it', () => {
    const before = rich('see docs', 'see <a href="https://a.example">docs</a>');
    const after = rich(
      'see docs now',
      'see <a href="https://a.example">docs</a> now',
    );

    const html = annotateRevision(before, after);

    expect(html).toContain('<a href="https://a.example">docs</a>');
  });

  // The text is user-controlled; it must land as text, never as markup. Asserted
  // structurally: the escaped text legitimately *contains* the string "onerror=alert",
  // so what matters is that no element was created from it.
  it('cannot be talked into emitting markup from message text', () => {
    const before = plain('hello');
    const after = plain('hello <img src=x onerror=alert(1)>');

    const rendered = render(annotateRevision(before, after));

    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.querySelectorAll('*')).toHaveLength(1); // the <ins> and nothing else
    expect(rendered.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  // A replacement lands both marks at the same offset. If the deletion goes inside the
  // insertion, the old word reads as having been added and struck through at once.
  it('puts a replaced word beside its replacement, not inside it', () => {
    const rendered = render(
      annotateRevision(plain('meet at noon'), plain('meet at midnight')),
    );

    expect(rendered.querySelector('ins del')).toBeNull();
    expect(rendered.querySelector('del ins')).toBeNull();
    expect(rendered.querySelector('ins.diff-ins')?.textContent).toBe(
      'midnight',
    );
    expect(rendered.querySelector('del.diff-del')?.textContent).toBe('noon');
  });

  // Diffing characters makes this ordinary rather than exotic: one changed run can start
  // in a bold span and finish in the plain text after it. The marks have to split across
  // both, and neither element may be disturbed.
  it('marks a change that straddles an element boundary', () => {
    const before = rich('abcdef', '<strong>abc</strong>def');
    const after = rich('abXYef', '<strong>abX</strong>Yef');

    const rendered = render(annotateRevision(before, after));

    // The run is marked on both sides of the boundary, each inside its own element.
    expect(rendered.querySelector('strong ins.diff-ins')?.textContent).toBe(
      'X',
    );
    expect(
      [...rendered.querySelectorAll('ins.diff-ins')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['X', 'Y']);
    // Both elements survive — nothing was moved or replaced, only text split.
    expect(rendered.querySelectorAll('strong')).toHaveLength(1);
    expect(rendered.textContent).toBe('abcdXYef');
    // The deletion sits in whichever element holds that offset, so here it picks up the
    // bold. Removed text never carries its own formatting (it has no node in the new
    // tree); this is the same compromise seen from the other side, and it is why the
    // "Highlight changes" toggle exists.
    expect(rendered.querySelector('strong del.diff-del')?.textContent).toBe(
      'cd',
    );
  });

  // A spoiler hides its contents until the reader asks. The highlight has to land INSIDE
  // it — a mark placed as a sibling would sit outside the concealment and show the edited
  // words through it, which is a privacy bug rather than a cosmetic one.
  it('keeps a highlight inside the spoiler it belongs to', () => {
    const before = rich(
      'the butler did it',
      '<span class="mx-spoiler">the butler</span> did it',
    );
    const after = rich(
      'the gardener did it',
      '<span class="mx-spoiler">the gardener</span> did it',
    );

    const rendered = render(annotateRevision(before, after));

    // Every mark is a DESCENDANT of the spoiler — none escaped to sit beside it, where
    // the concealment would not cover it. Exact wording is the diff's business: "butler"
    // and "gardener" share the trailing "er", so the marks fall on the parts that differ.
    const marks = [...rendered.querySelectorAll('ins.diff-ins, del.diff-del')];
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.closest('.mx-spoiler')).not.toBeNull();
    }
    expect(rendered.querySelector('.mx-spoiler')?.textContent).toContain(
      'garden',
    );
    // Nothing leaked into the visible tail of the message.
    expect(rendered.textContent?.endsWith(' did it')).toBe(true);
  });

  it('keeps an astral character whole when annotating', () => {
    const rendered = render(
      annotateRevision(plain('party 🎉 time'), plain('party 🎊 time')),
    );

    expect(rendered.querySelector('ins.diff-ins')?.textContent).toBe('🎊');
    expect(rendered.querySelector('del.diff-del')?.textContent).toBe('🎉');
    // No orphaned halves of a surrogate pair anywhere in the output.
    expect(rendered.innerHTML).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('says nothing when only the formatting changed', () => {
    const before = rich('ship it', 'ship it');
    const after = rich('ship it', '<strong>ship it</strong>');

    expect(annotateRevision(before, after)).toBeNull();
  });

  it('says nothing when a version could not be decrypted', () => {
    const locked = revision({ kind: 'undecryptable', body: 'no key' });

    expect(annotateRevision(locked, plain('hello'))).toBeNull();
    expect(annotateRevision(plain('hello'), locked)).toBeNull();
  });

  it('handles an edit that only trims the end of a message', () => {
    const html = annotateRevision(plain('call me tomorrow'), plain('call me'));

    expect(html).toContain('<del class="diff-del">');
    expect(html).toContain('tomorrow');
  });
});
