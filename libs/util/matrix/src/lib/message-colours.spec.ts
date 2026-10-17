import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml, sanitizeOutgoingHtml } from './message-html';

function first(html: string, selector: string): Element | null {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element.querySelector(selector);
}

const classesOf = (html: string, selector: string): string[] =>
  [...(first(html, selector)?.classList ?? [])].sort();

describe('sender colours become checked class tokens', () => {
  it('tokenizes a span’s text and background colours in lower case', () => {
    expect(
      classesOf(
        sanitizeMatrixHtml(
          '<span data-mx-color="#E03030" data-mx-bg-color="#FFEB3B">x</span>',
        ),
        'span',
      ),
    ).toEqual(['mx-bg-ffeb3b', 'mx-fg-e03030']);
  });

  it('tokenizes the deprecated font colour and removes the attribute', () => {
    const clean = sanitizeMatrixHtml('<font color="#2e7d32">x</font>');

    expect(classesOf(clean, 'font')).toEqual(['mx-fg-2e7d32']);
    expect(first(clean, 'font')?.hasAttribute('color')).toBe(false);
  });

  it('prefers a font’s data-mx-color over its color', () => {
    expect(
      classesOf(
        sanitizeMatrixHtml(
          '<font data-mx-color="#111111" color="#222222">x</font>',
        ),
        'font',
      ),
    ).toEqual(['mx-fg-111111']);
  });

  it('falls back to a font’s valid color when its data-mx-color is invalid', () => {
    expect(
      classesOf(
        sanitizeMatrixHtml(
          '<font data-mx-color="red" color="#222222">x</font>',
        ),
        'font',
      ),
    ).toEqual(['mx-fg-222222']);
  });

  it.each([
    '#abc',
    'red',
    'rgb(1, 2, 3)',
    '#e03030ff',
    'e03030',
    '',
    '#e03030 mx-fg-000000',
    '#e03030\tmx-bg-000000',
  ])('ignores %j', (value) => {
    expect(
      classesOf(
        sanitizeMatrixHtml(
          `<span data-mx-color="${value}" data-mx-bg-color="${value}">x</span>`,
        ),
        'span',
      ),
    ).toEqual([]);
  });

  it.each([' #e03030', '#e03030\n'])(
    'reads %j as DOMPurify trims it, one token and nothing more',
    (value) => {
      // DOMPurify trims every attribute value before the hooks see it (as HTML's legacy colour
      // rule does for `font color`), so only surrounding whitespace is forgiven: the colour is
      // still exactly `#RRGGBB` and still goes through the contrast guard.
      expect(
        classesOf(
          sanitizeMatrixHtml(`<span data-mx-color="${value}">x</span>`),
          'span',
        ),
      ).toEqual(['mx-fg-e03030']);
    },
  );

  it('tokenizes a font’s background colour on its own', () => {
    expect(
      classesOf(
        sanitizeMatrixHtml('<font data-mx-bg-color="#FFEB3B">x</font>'),
        'font',
      ),
    ).toEqual(['mx-bg-ffeb3b']);
  });

  it('leaves a font with no usable colour untokenized and without color', () => {
    const clean = sanitizeMatrixHtml(
      '<font data-mx-color="red" color="#abc">x</font>',
    );

    expect(classesOf(clean, 'font')).toEqual([]);
    expect(first(clean, 'font')?.hasAttribute('color')).toBe(false);
  });

  it('removes a font color it cannot use, so nothing unchecked is painted', () => {
    const clean = sanitizeMatrixHtml('<font color="red">x</font>');

    expect(classesOf(clean, 'font')).toEqual([]);
    expect(first(clean, 'font')?.hasAttribute('color')).toBe(false);
  });

  it('strips colour classes a sender wrote', () => {
    expect(
      classesOf(
        sanitizeMatrixHtml('<span class="mx-fg-ff0000 mx-bg-00ff00">x</span>'),
        'span',
      ),
    ).toEqual([]);
  });

  it('reads colours only where the spec allows them', () => {
    expect(
      classesOf(sanitizeMatrixHtml('<p data-mx-color="#e03030">x</p>'), 'p'),
    ).toEqual([]);
  });

  it('sends the sender’s attributes and none of the tokens', () => {
    const outgoing = sanitizeOutgoingHtml(
      '<span data-mx-color="#e03030">x</span>',
    );

    expect(outgoing).toContain('data-mx-color="#e03030"');
    expect(outgoing).not.toContain('mx-fg-');
  });
});
