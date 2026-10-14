import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml, sanitizeOutgoingHtml } from './message-view';

function parse(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

const images = (count: number, emoji = false): string =>
  Array.from(
    { length: count },
    (_, i) =>
      `<img ${emoji ? 'data-mx-emoticon ' : ''}src="mxc://hs/${emoji ? 'e' : 'i'}${i}" alt="${emoji ? 'e' : 'i'}${i}">`,
  ).join('');

describe('inline images in formatted bodies', () => {
  it('marks an mxc image for the render leaf and moves its source off src', () => {
    const image = parse(
      sanitizeMatrixHtml(
        '<img src="mxc://hs/pic" width="400" height="900" alt="A tall picture">',
      ),
    ).querySelector('img');

    expect(image?.classList.contains('mx-image')).toBe(true);
    expect(image?.hasAttribute('src')).toBe(false);
    expect(image?.getAttribute('data-mx-src')).toBe('mxc://hs/pic');
    expect(image?.getAttribute('width')).toBe('400');
    expect(image?.getAttribute('height')).toBe('900');
    expect(image?.getAttribute('role')).toBe('button');
    expect(image?.getAttribute('tabindex')).toBe('0');
    expect(image?.getAttribute('aria-label')).toBe(
      'View image: A tall picture',
    );
  });

  it('names an image without alt text "Image"', () => {
    const image = parse(
      sanitizeMatrixHtml('<img src="mxc://hs/pic">'),
    ).querySelector('img');

    expect(image?.getAttribute('alt')).toBe('Image');
    expect(image?.getAttribute('aria-label')).toBe('View image');
  });

  it('leaves an image inside a link to the link', () => {
    const image = parse(
      sanitizeMatrixHtml(
        '<a href="https://example.org/full"><img src="mxc://hs/thumb" alt="thumb"></a>',
      ),
    ).querySelector('img');

    expect(image?.classList.contains('mx-image')).toBe(true);
    expect(image?.hasAttribute('role')).toBe(false);
    expect(image?.hasAttribute('tabindex')).toBe(false);
    expect(image?.hasAttribute('aria-label')).toBe(false);
  });

  it.each([
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:https://example.org/1',
    'https://tracker.example/pixel.png',
    'mxc://no-media-id',
  ])('turns an image from %s into its alt text', (source) => {
    const clean = sanitizeMatrixHtml(
      `<img src="${source}" alt="what it showed">`,
    );

    expect(parse(clean).querySelector('img')).toBeNull();
    expect(clean).toContain('what it showed');
    expect(clean).not.toContain(source);
  });

  it('shows at most 10 inline images and the rest as their alt text', () => {
    const clean = parse(sanitizeMatrixHtml(images(12)));

    expect(clean.querySelectorAll('img.mx-image')).toHaveLength(10);
    expect(clean.textContent).toBe('i10i11');
  });

  it('counts emoji apart from images', () => {
    const clean = parse(sanitizeMatrixHtml(images(12, true) + images(10)));

    expect(clean.querySelectorAll('img.mx-emoticon')).toHaveLength(12);
    expect(clean.querySelectorAll('img.mx-image')).toHaveLength(10);
  });

  it('sends the mxc source and none of the render markup', () => {
    const outgoing = sanitizeOutgoingHtml('<img src="mxc://hs/pic" alt="a">');

    expect(outgoing).toContain('src="mxc://hs/pic"');
    expect(outgoing).not.toContain('data-mx-src');
    expect(outgoing).not.toContain('mx-image');
    expect(outgoing).not.toContain('role=');
  });
});
