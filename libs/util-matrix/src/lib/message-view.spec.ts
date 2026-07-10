import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml } from './message-view';

/** Parse sanitized HTML back into a document fragment for attribute assertions. */
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

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
