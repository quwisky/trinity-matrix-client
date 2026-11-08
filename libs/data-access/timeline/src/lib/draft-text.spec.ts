import { describe, expect, it } from 'vitest';
import { appendDraft } from './draft-text';

describe('appendDraft', () => {
  it('adds text as its own paragraph after a draft', () => {
    expect(appendDraft('typed', 'caption')).toBe('typed\n\ncaption');
    expect(appendDraft('typed\n', 'caption')).toBe('typed\n\ncaption');
  });

  it('is the text alone when the draft is blank, and the draft alone when the text is', () => {
    expect(appendDraft('  ', 'caption')).toBe('caption');
    expect(appendDraft('typed', ' ')).toBe('typed');
  });

  it('keeps a paragraph the draft already holds', () => {
    expect(appendDraft('ok', 'ok')).toBe('ok\n\nok');
  });
});
