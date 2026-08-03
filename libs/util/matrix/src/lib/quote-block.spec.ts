import { describe, expect, it } from 'vitest';
import { applyFormat, quoteBlock } from './markdown-edit';

describe('quoteBlock', () => {
  it('quotes a single line and leaves the caret a blank line to type on', () => {
    expect(quoteBlock('hello there')).toBe('> hello there\n\n');
  });

  it('quotes every line of a multi-line body', () => {
    expect(quoteBlock('one\ntwo')).toBe('> one\n> two\n\n');
  });

  it('marks the blank line between paragraphs, with no trailing space', () => {
    // CommonMark ends a blockquote at an UNmarked blank line, so leaving it bare would
    // render the second paragraph as the quoter's own words.
    expect(quoteBlock('first\n\nsecond')).toBe('> first\n>\n> second\n\n');
  });

  it('quotes an already-quoted body instead of unquoting it', () => {
    // The distinction from the composer's quote BUTTON, which toggles.
    expect(quoteBlock('> theirs')).toBe('> > theirs\n\n');
    expect(applyFormat('> theirs', 0, 8, 'quote').text).toBe('theirs');
  });

  it('has nothing to quote for an empty or whitespace-only body', () => {
    expect(quoteBlock('')).toBe('');
    expect(quoteBlock('   \n  ')).toBe('');
  });
});
