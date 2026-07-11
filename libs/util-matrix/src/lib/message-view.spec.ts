import { describe, expect, it } from 'vitest';
import {
  firstUrl,
  linkifyText,
  parseGeoUri,
  sanitizeMatrixHtml,
} from './message-view';

describe('parseGeoUri', () => {
  it('parses lat/lng from a geo URI', () => {
    expect(parseGeoUri('geo:52.51,13.38')).toEqual({ lat: 52.51, lng: 13.38 });
  });

  it('handles negative coordinates and ignores an uncertainty suffix', () => {
    expect(parseGeoUri('geo:-33.86,151.21;u=35')).toEqual({
      lat: -33.86,
      lng: 151.21,
    });
  });

  it('returns null for a non-geo or malformed value', () => {
    expect(parseGeoUri('https://example.com')).toBeNull();
    expect(parseGeoUri('geo:not,coords')).toBeNull();
    expect(parseGeoUri(undefined)).toBeNull();
  });
});

describe('firstUrl', () => {
  it('returns the first http(s) URL', () => {
    expect(firstUrl('see https://example.com/x and http://b.test')).toBe(
      'https://example.com/x',
    );
  });

  it('trims trailing sentence punctuation', () => {
    expect(firstUrl('go to https://example.com.')).toBe('https://example.com');
    expect(firstUrl('(https://example.com)')).toBe('https://example.com');
  });

  it('returns null when there is no URL', () => {
    expect(firstUrl('no links here')).toBeNull();
  });
});

/** Parse sanitized HTML back into a document fragment for attribute assertions. */
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('linkifyText', () => {
  it('wraps a bare URL in an anchor, keeping the surrounding text', () => {
    expect(linkifyText('check https://example.com now')).toBe(
      'check <a href="https://example.com">https://example.com</a> now',
    );
  });

  it('returns null when there is no URL (keeps plain-text rendering)', () => {
    expect(linkifyText('just some text')).toBeNull();
  });

  it('leaves trailing sentence punctuation outside the link', () => {
    expect(linkifyText('see https://example.com.')).toBe(
      'see <a href="https://example.com">https://example.com</a>.',
    );
  });

  it('linkifies multiple URLs', () => {
    const html = linkifyText('https://a.com and https://b.com');
    expect(html).toContain('<a href="https://a.com">https://a.com</a>');
    expect(html).toContain('<a href="https://b.com">https://b.com</a>');
  });

  it('HTML-escapes the surrounding text and the URL', () => {
    // The `<script>` is escaped (not executable), and `&` in the query is escaped.
    const html = linkifyText('<script> https://x.com/?a=1&b=2');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://x.com/?a=1&amp;b=2"');
  });

  it('renders newlines as <br>', () => {
    expect(linkifyText('a\nhttps://x.com')).toBe(
      'a<br><a href="https://x.com">https://x.com</a>',
    );
  });
});

describe('sanitizeMatrixHtml — spoilers', () => {
  it('tags a spoiler with the mx-spoiler class and makes it keyboard-activatable', () => {
    const clean = sanitizeMatrixHtml(
      'peek: <span data-mx-spoiler>the butler did it</span>',
    );
    // The mx-spoiler *class* is what the renderer keys off — it survives Angular's
    // [innerHTML] sanitizer, unlike the data-mx-spoiler attribute.
    const spoiler = parse(clean).querySelector('.mx-spoiler');

    expect(spoiler).not.toBeNull();
    expect(spoiler?.textContent).toBe('the butler did it');
    expect(spoiler?.getAttribute('tabindex')).toBe('0');
    expect(spoiler?.getAttribute('role')).toBe('button');
  });

  it('keeps a spoiler reason on the attribute', () => {
    const clean = sanitizeMatrixHtml(
      '<span data-mx-spoiler="ending">she lives</span>',
    );
    const spoiler = parse(clean).querySelector('[data-mx-spoiler]');
    expect(spoiler?.getAttribute('data-mx-spoiler')).toBe('ending');
  });

  it('does not make ordinary spans focusable', () => {
    const clean = sanitizeMatrixHtml('<span>just text</span>');
    const span = parse(clean).querySelector('span');
    expect(span?.hasAttribute('tabindex')).toBe(false);
    expect(span?.hasAttribute('role')).toBe(false);
  });

  it('still strips dangerous markup around a spoiler', () => {
    const clean = sanitizeMatrixHtml(
      '<span data-mx-spoiler onclick="steal()">x</span><script>bad()</script>',
    );
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<script');
  });
});
