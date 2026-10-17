import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml, sanitizeOutgoingHtml } from './message-html';

function parse(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

describe('maths in formatted bodies', () => {
  it('marks inline and display maths and keeps the sender’s fallback', () => {
    const clean = parse(
      sanitizeMatrixHtml(
        '<span data-mx-maths="x^2"><code>x^2</code></span><div data-mx-maths="\\frac{1}{2}"><code>\\frac{1}{2}</code></div>',
      ),
    );

    expect(clean.querySelector('span')?.classList.contains('mx-maths')).toBe(
      true,
    );
    expect(clean.querySelector('div')?.classList.contains('mx-maths')).toBe(
      true,
    );
    expect(clean.querySelector('span')?.getAttribute('data-mx-maths')).toBe(
      'x^2',
    );
    expect(clean.querySelector('span code')?.textContent).toBe('x^2');
  });

  it('turns an image in a maths fallback into its alt text, so the next image keeps its own source', () => {
    const clean = parse(
      sanitizeMatrixHtml(
        '<span data-mx-maths="x"><img src="mxc://hs/a" alt="A"></span> and <img src="mxc://hs/b" alt="B">',
      ),
    );

    expect(clean.querySelector('.mx-maths')?.textContent).toBe('A');
    const images = [...clean.querySelectorAll('img.mx-image')];
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('data-mx-src')).toBe('mxc://hs/b');
    expect(images[0].getAttribute('alt')).toBe('B');
  });

  it('leaves empty maths as its fallback', () => {
    expect(
      parse(sanitizeMatrixHtml('<span data-mx-maths="  ">fallback</span>'))
        .querySelector('span')
        ?.classList.contains('mx-maths'),
    ).toBe(false);
  });

  it('marks maths only where the spec allows it', () => {
    const paragraph = parse(
      sanitizeMatrixHtml('<p data-mx-maths="x">p</p>'),
    ).querySelector('p');

    expect(paragraph?.getAttributeNames()).toEqual([]);
  });

  it('sends data-mx-maths and no marker', () => {
    const outgoing = sanitizeOutgoingHtml('<span data-mx-maths="x^2">x</span>');

    expect(outgoing).toContain('data-mx-maths="x^2"');
    expect(outgoing).not.toContain('class=');
  });
});
