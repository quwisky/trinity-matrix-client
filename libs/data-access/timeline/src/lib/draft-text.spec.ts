import { describe, expect, it } from 'vitest';
import { appendDraft, putBackDraft, withoutSent } from './draft-text';

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

describe('putBackDraft', () => {
  it('puts a failed message in front of the draft, once', () => {
    expect(putBackDraft('typed', 'failed')).toBe('failed\n\ntyped');
    expect(putBackDraft('', 'failed')).toBe('failed');
    expect(putBackDraft('failed\n\ntyped', 'failed')).toBe('failed\n\ntyped');
    expect(putBackDraft('typed\n\nfailed', 'failed')).toBe('failed\n\ntyped');
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

  it('removes the sent message wherever it sits, once', () => {
    expect(withoutSent('failed\n\nhi', 'hi')).toBe('failed');
    expect(withoutSent('x\n\na\n\nb\n\ny', 'a\n\nb')).toBe('x\n\ny');
  });

  it('leaves a draft that does not hold the sent message alone', () => {
    expect(withoutSent('typed since', 'hi')).toBe('typed since');
    expect(withoutSent('hi there', 'hi')).toBe('hi there');
    expect(withoutSent('a\n\nx\n\nb', 'a\n\nb')).toBe('a\n\nx\n\nb');
  });
});
