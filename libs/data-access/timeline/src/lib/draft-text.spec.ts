import { describe, expect, it } from 'vitest';
import { appendDraft, withoutSent } from './draft-text';

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

describe('withoutSent', () => {
  it('removes the sent message that leads the draft and keeps what follows', () => {
    expect(withoutSent('hi', 'hi')).toBe('');
    expect(withoutSent('hi\n\ncaption', 'hi')).toBe('caption');
    expect(withoutSent('a\n\nb\n\ncaption', 'a\n\nb')).toBe('caption');
  });

  it('keeps a later paragraph that reads like the sent message', () => {
    expect(withoutSent('ok\n\nok', 'ok')).toBe('ok');
  });

  it('leaves a draft that does not start with the sent message alone', () => {
    expect(withoutSent('typed since', 'hi')).toBe('typed since');
    expect(withoutSent('caption\n\nhi', 'hi')).toBe('caption\n\nhi');
    expect(withoutSent('hi there', 'hi')).toBe('hi there');
  });
});
