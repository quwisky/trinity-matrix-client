import { describe, expect, it } from 'vitest';
import type { DomSanitizer } from '@angular/platform-browser';
import type { MatrixEvent } from 'matrix-js-sdk';
import { mediaCaptionFields, messagePreview } from './message-content';

// mediaCaptionFields only uses the sanitizer via renderMarkdown (marked → sanitize);
// a passthrough stub is enough to exercise the markdown branch without a DOM.
const sanitizer = {
  sanitize: (_ctx: unknown, html: string | null) => html,
} as unknown as DomSanitizer;

describe('mediaCaptionFields', () => {
  it('uses the filename as the body when there is no caption', () => {
    expect(mediaCaptionFields(sanitizer, 'pic.png', '')).toEqual({
      body: 'pic.png',
    });
    // Whitespace-only is treated as no caption.
    expect(mediaCaptionFields(sanitizer, 'pic.png', '   ')).toEqual({
      body: 'pic.png',
    });
  });

  it('sets body=caption + filename for a plain caption (MSC2530)', () => {
    expect(mediaCaptionFields(sanitizer, 'pic.png', 'a caption')).toEqual({
      body: 'a caption',
      filename: 'pic.png',
    });
  });

  it('trims the caption', () => {
    expect(mediaCaptionFields(sanitizer, 'pic.png', '  hi  ')).toEqual({
      body: 'hi',
      filename: 'pic.png',
    });
  });

  it('adds a formatted_body for a markdown caption', () => {
    const fields = mediaCaptionFields(
      sanitizer,
      'pic.png',
      'a **bold** caption',
    );
    expect(fields['body']).toBe('a **bold** caption');
    expect(fields['filename']).toBe('pic.png');
    expect(fields['format']).toBe('org.matrix.custom.html');
    expect(fields['formatted_body']).toContain('<strong>bold</strong>');
  });

  it('omits format for a caption with no markdown formatting', () => {
    const fields = mediaCaptionFields(sanitizer, 'pic.png', 'just text');
    expect(fields['format']).toBeUndefined();
    expect(fields['formatted_body']).toBeUndefined();
  });
});

// A fake shaped like the bits messagePreview() reads off a MatrixEvent.
function fakeEvent(o: {
  body?: string;
  redacted?: boolean;
  decryptFail?: boolean;
}): MatrixEvent {
  return {
    getContent: () => ({ body: o.body ?? '' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
  } as unknown as MatrixEvent;
}

describe('messagePreview', () => {
  it('returns the body trimmed and with internal whitespace collapsed', () => {
    expect(messagePreview(fakeEvent({ body: '  hello   world  \n\n' }))).toBe(
      'hello world',
    );
  });

  it('strips a reply fallback quote, keeping only the actual message', () => {
    const event = fakeEvent({
      body: '> <@user:hs> quoted\n\nactual',
    });
    expect(messagePreview(event)).toBe('actual');
  });

  it("returns '(message deleted)' for a redacted event", () => {
    const event = fakeEvent({ body: 'gone now', redacted: true });
    expect(messagePreview(event)).toBe('(message deleted)');
  });

  it("returns '⚠️ Unable to decrypt' for a decryption failure, before checking redaction", () => {
    const event = fakeEvent({ decryptFail: true, redacted: true });
    expect(messagePreview(event)).toBe('⚠️ Unable to decrypt');
  });

  it("returns '…' for an empty or whitespace-only body", () => {
    expect(messagePreview(fakeEvent({ body: '' }))).toBe('…');
    expect(messagePreview(fakeEvent({ body: '   \n  ' }))).toBe('…');
  });
});
