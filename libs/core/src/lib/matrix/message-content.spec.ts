import { describe, expect, it } from 'vitest';
import type { DomSanitizer } from '@angular/platform-browser';
import { mediaCaptionFields } from './message-content';

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
