import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml, sanitizeOutgoingHtml } from './message-html';

/** The sanitized body as a tree, for attribute assertions. */
function parse(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

const names = (element: Element | null): string[] =>
  [...(element?.getAttributeNames() ?? [])].sort();

/** How deep the deepest element sits below `root` (its children are depth 1). Iterative. */
function maxDepth(root: Element): number {
  let deepest = 0;
  const pending: Array<[Element, number]> = [[root, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [element, depth] = next;
    deepest = Math.max(deepest, depth);
    for (const child of element.children) pending.push([child, depth + 1]);
  }
  return deepest;
}

const nested = (levels: number, text: string): string =>
  '<b>'.repeat(levels) + text + '</b>'.repeat(levels);

describe('the Matrix HTML allowlist (spec v1.19)', () => {
  it.each([
    ['render', sanitizeMatrixHtml],
    ['send', sanitizeOutgoingHtml],
  ])('keeps s and drops ruby on the %s path', (_path, sanitize) => {
    const clean = parse(
      sanitize('<s>gone</s><ruby>漢<rt>kan</rt><rp>(</rp></ruby>'),
    );

    expect(clean.querySelector('s')?.textContent).toBe('gone');
    expect(clean.querySelector('ruby, rt, rp')).toBeNull();
    expect(clean.textContent).toContain('漢');
  });

  it('allows each attribute only on the tag the spec lists it for', () => {
    const clean = parse(
      sanitizeOutgoingHtml(
        '<a href="https://example.org/a" title="t" name="n">a</a>' +
          '<span title="t" data-mx-color="#112233" data-mx-bg-color="#445566" data-mx-spoiler="why" data-mx-maths="x" data-foo="1" aria-label="spoof" class="language-js">s</span>' +
          '<div data-mx-maths="y" data-mx-color="#112233" title="t">d</div>' +
          '<p data-mx-maths="z" title="t">p</p>' +
          '<ol start="3" title="t"><li title="t">i</li></ol>' +
          '<img src="mxc://hs/a" width="10" height="20" alt="alt" title="t" data-mx-spoiler="x">' +
          '<code class="language-js other" title="t">c</code>',
      ),
    );

    expect(names(clean.querySelector('a'))).toEqual(['href']);
    expect(names(clean.querySelector('span'))).toEqual([
      'data-mx-bg-color',
      'data-mx-color',
      'data-mx-maths',
      'data-mx-spoiler',
    ]);
    expect(names(clean.querySelector('div'))).toEqual(['data-mx-maths']);
    expect(names(clean.querySelector('p'))).toEqual([]);
    expect(names(clean.querySelector('ol'))).toEqual(['start']);
    expect(names(clean.querySelector('li'))).toEqual([]);
    expect(names(clean.querySelector('img'))).toEqual([
      'alt',
      'height',
      'src',
      'title',
      'width',
    ]);
    expect(clean.querySelector('code')?.getAttribute('class')).toBe(
      'language-js',
    );
  });

  it('keeps the values DOMPurify used to drop as non-URIs', () => {
    const clean = parse(
      sanitizeOutgoingHtml(
        '<ol start="3"><li>c</li></ol><img src="mxc://hs/a" width="10" height="20" alt="a">',
      ),
    );

    expect(clean.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(clean.querySelector('img')?.getAttribute('width')).toBe('10');
    expect(clean.querySelector('img')?.getAttribute('height')).toBe('20');
  });

  // Spec v1.19 allows `width`/`height` on `img` only. A sender's size reserves the image's box;
  // the feature layer draws an inline image at most 300px tall and the body's width
  // (InlineMxcImagesDirective and rendered-markdown.scss), so even a huge size cannot open an
  // arbitrarily tall empty box.
  it.each([
    ['render', sanitizeMatrixHtml],
    ['send', sanitizeOutgoingHtml],
  ])(
    'keeps image sizes from senders on img only on the %s path',
    (_path, sanitize) => {
      const clean = parse(
        sanitize(
          '<img src="mxc://hs/a" width="10" height="20000" alt="a">' +
            '<p width="10" height="20">p</p><span width="10" height="20">s</span>',
        ),
      );
      const img = clean.querySelector('img');

      expect(img?.getAttribute('width')).toBe('10');
      expect(img?.getAttribute('height')).toBe('20000');
      expect(names(clean.querySelector('p'))).toEqual([]);
      expect(names(clean.querySelector('span'))).toEqual([]);
    },
  );

  it('keeps color, start, width and height only on the tags the spec lists them for', () => {
    const clean = parse(
      sanitizeOutgoingHtml(
        '<span color="#112233">s</span><ul start="2"><li>u</li></ul>' +
          '<div width="10" height="20">d</div><ol color="#112233" width="5">o</ol>' +
          '<p><font color="#112233">f</font></p>',
      ),
    );

    expect(names(clean.querySelector('span'))).toEqual([]);
    expect(names(clean.querySelector('ul'))).toEqual([]);
    expect(names(clean.querySelector('div'))).toEqual([]);
    expect(names(clean.querySelector('ol'))).toEqual([]);
    // The send path unwraps font (never emitted), so check it where it is still read. The
    // colour survives DOMPurify and the render pass turns it into an `mx-fg-` token.
    const font = parse(
      sanitizeMatrixHtml('<font color="#112233" width="5">f</font>'),
    ).querySelector('font')!;
    expect(font.hasAttribute('width')).toBe(false);
    expect(font.hasAttribute('color')).toBe(false);
    expect(font.className).toBe('mx-fg-112233');
  });

  it('drops attributes a sender adds that the spec does not list, on the render path too', () => {
    const clean = parse(
      sanitizeMatrixHtml(
        '<span title="t" data-foo="1" aria-label="spoof" class="mx-fg-ff0000 language-js">x</span>' +
          '<p name="n" title="t">p</p><ol start="3"><li>c</li></ol>' +
          '<pre class="language-js"><code class="language-js other">c</code></pre>',
      ),
    );

    expect(names(clean.querySelector('span'))).toEqual([]);
    expect(names(clean.querySelector('p'))).toEqual([]);
    expect(clean.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(clean.querySelector('pre')?.hasAttribute('class')).toBe(false);
    expect(clean.querySelector('code')?.getAttribute('class')).toBe(
      'language-js',
    );
  });

  it.each([
    ['render', sanitizeMatrixHtml],
    ['send', sanitizeOutgoingHtml],
  ])(
    'flattens nesting deeper than 100 on the %s path, keeping the text',
    (_path, sanitize) => {
      const clean = parse(sanitize(nested(150, 'deep text')));

      expect(maxDepth(clean)).toBe(100);
      expect(clean.textContent).toBe('deep text');
    },
  );

  it('stays bounded on pathologically deep input', () => {
    expect(
      maxDepth(parse(sanitizeMatrixHtml(nested(2_000, 'x')))),
    ).toBeLessThanOrEqual(100);
  });

  it('still reads font and strike from older messages', () => {
    const clean = parse(
      sanitizeMatrixHtml('<font>old</font><strike>gone</strike>'),
    );

    expect(clean.querySelector('font')?.textContent).toBe('old');
    expect(clean.querySelector('strike')?.textContent).toBe('gone');
  });

  it('never sends font or strike', () => {
    expect(
      sanitizeOutgoingHtml('<font color="#112233">f</font><strike>s</strike>'),
    ).toBe('f<del>s</del>');
  });

  it.each([
    ['<ol start="100000"><li>a</li><li>b</li></ol>', 'mx-ol-long'],
    ['<ol start="98"><li>a</li><li>b</li><li>c</li></ol>', 'mx-ol-long'],
    ['<ol start="-10"><li>a</li></ol>', 'mx-ol-long'],
    ['<ol start="97"><li>a</li><li>b</li><li>c</li></ol>', 'mx-ol-wide'],
    ['<ol start="-9"><li>a</li></ol>', 'mx-ol-wide'],
    ['<ol start="8"><li>a</li><li>b</li></ol>', ''],
    ['<ol start="8"><li>a</li><li>b</li><li>c</li></ol>', 'mx-ol-wide'],
    ['<ol start="x"><li>a</li></ol>', ''],
    [`<ol>${'<li>i</li>'.repeat(9)}</ol>`, ''],
    [`<ol>${'<li>i</li>'.repeat(99)}</ol>`, 'mx-ol-wide'],
    [`<ol>${'<li>i</li>'.repeat(100)}</ol>`, 'mx-ol-long'],
  ])('marks %s by how far its numbers reach', (html, mark) => {
    const list = parse(sanitizeMatrixHtml(html)).querySelector('ol');

    expect(list?.className).toBe(mark);
  });

  it('never sends the wide-list mark', () => {
    expect(
      sanitizeOutgoingHtml('<ol start="100000"><li>a</li></ol>'),
    ).not.toMatch(/mx-ol-/);
  });
});
