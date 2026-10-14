import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MATHS_SOURCE_LENGTH,
  renderMaths,
  sanitizeMathsMarkup,
} from './maths-render';

/** Anything in `fragment` that could run code or reach the network. */
function dangerous(fragment: DocumentFragment): string[] {
  const found: string[] = [];
  for (const element of fragment.querySelectorAll('*')) {
    const tag = element.localName.toLowerCase();
    if (
      [
        'script',
        'foreignobject',
        'use',
        'image',
        'img',
        'a',
        'iframe',
        'style',
      ].includes(tag)
    ) {
      found.push(tag);
    }
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? '';
      if (
        name.startsWith('on') ||
        name === 'href' ||
        name === 'xlink:href' ||
        name === 'src'
      ) {
        found.push(`${tag}[${name}]`);
      }
      if (name === 'style' && /url\s*\(|image-set|\\/i.test(value)) {
        found.push(`${tag}[style url]`);
      }
    }
  }
  return found;
}

function rendered(latex: string, display = false): DocumentFragment {
  const outcome = renderMaths(latex, display);
  if (outcome.kind !== 'rendered') {
    throw new Error('expected the expression to render');
  }
  return outcome.fragment;
}

describe('renderMaths (real KaTeX)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders inline maths with MathML for screen readers and hides the visual copy', () => {
    const fragment = rendered('e^{i\\pi} + 1 = 0');

    expect(fragment.querySelector('.katex')).not.toBeNull();
    expect(fragment.querySelector('.katex-display')).toBeNull();
    expect(fragment.querySelector('math')).not.toBeNull();
    expect(fragment.querySelector('annotation')?.getAttribute('encoding')).toBe(
      'application/x-tex',
    );
    expect(
      fragment.querySelector('.katex-html')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('renders display maths in display mode', () => {
    expect(
      rendered('\\int_0^1 x^2 \\, dx', true).querySelector('.katex-display'),
    ).not.toBeNull();
  });

  it('keeps the SVG KaTeX draws for a square root', () => {
    expect(
      rendered('\\sqrt{x^2 + y^2}').querySelector('svg path'),
    ).not.toBeNull();
  });

  it.each([
    '\\href{https://evil.example}{click}',
    '\\url{https://evil.example}',
    '\\includegraphics{https://evil.example/x.png}',
    '\\htmlClass{x}{y}',
  ])('renders no link, image or URL for %s', (latex) => {
    const outcome = renderMaths(latex, false);

    if (outcome.kind === 'rendered') {
      expect(
        outcome.fragment.querySelector('a, img, image, use, [href], [src]'),
      ).toBeNull();
    }
  });

  it.each([
    '\\text{<script>alert(1)</script>}',
    '\\text{<img src=x onerror=alert(1)>}',
    '\\href{javascript:alert(1)}{x}',
    '\\htmlStyle{background:url(https://evil.example/x)}{x}',
    '\\color{red;background:url(https://evil.example/x)}{x}',
    '\\text{<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>}',
  ])(
    'lets no code or network reference through from the maths payload %s',
    (latex) => {
      const outcome = renderMaths(latex, false);

      if (outcome.kind === 'rendered') {
        expect(dangerous(outcome.fragment)).toEqual([]);
      }
    },
  );

  it('strips hostile SVG and styles even if KaTeX were to emit them', () => {
    const fragment = sanitizeMathsMarkup(
      '<span class="katex"><svg width="1em" height="1em" viewBox="0 0 10 10" onload="alert(1)">' +
        '<foreignObject><img src="x" onerror="alert(1)"></foreignObject>' +
        '<a xlink:href="https://evil.example/"><path d="M0 0L10 10"/></a>' +
        '<use href="https://evil.example/sprite.svg#x"/><script>alert(1)</script>' +
        '<image href="https://evil.example/x.png"/>' +
        '<line x1="0" y1="0" x2="10" y2="10" stroke-width="1"/></svg>' +
        '<span style="background:url(https://evil.example/x)">x</span>' +
        '<span style="background:u\\rl(https://evil.example/x)">x</span>' +
        '<span style="background-image:image-set(\'https://evil.example/x.png\' 1x)">x</span>' +
        '<span style="width:1em">kept</span></span>',
    );

    expect(dangerous(fragment)).toEqual([]);
    // KaTeX's own geometry survives.
    expect(fragment.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 10 10',
    );
    expect(fragment.querySelector('svg path')?.getAttribute('d')).toBe(
      'M0 0L10 10',
    );
    expect(
      fragment.querySelector('svg line')?.getAttribute('stroke-width'),
    ).toBe('1');
    expect(fragment.querySelector('span[style]')?.getAttribute('style')).toBe(
      'width:1em',
    );
  });

  it('keeps its markup while the message sanitizer hooks the default DOMPurify instance', () => {
    // Loading message-view registers its per-tag table on the default instance, which strips
    // every class and style outside it; the maths sanitizer must not share that instance.
    expect(
      sanitizeMatrixHtml('<span class="katex" style="width:1em">x</span>'),
    ).toBe('<span>x</span>');

    const fragment = rendered('\\sqrt{x}');
    expect(fragment.querySelector('.katex .katex-html')).not.toBeNull();
    expect(fragment.querySelector('svg path')?.getAttribute('d')).toBeTruthy();
    expect(fragment.querySelector('[style]')).not.toBeNull();
  });

  it('shows the source for a macro expansion bomb', () => {
    const bomb =
      '\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\d\\d}\\def\\d{\\e\\e}' +
      '\\def\\e{\\f\\f}\\def\\f{\\g\\g}\\def\\g{x}\\a\\a\\a\\a';

    expect(renderMaths(bomb, false).kind).toBe('source');
  });

  it('shows the source past 2,000 characters and renders up to it', () => {
    expect(MAX_MATHS_SOURCE_LENGTH).toBe(2_000);
    expect(renderMaths('x'.repeat(2_000), false).kind).toBe('rendered');
    expect(renderMaths('x'.repeat(2_001), false).kind).toBe('source');
  });

  it('shows the source for LaTeX KaTeX cannot parse', () => {
    expect(renderMaths('\\frac{1}{', false).kind).toBe('source');
  });

  it('does not let a \\gdef leak into the next expression', () => {
    renderMaths('\\gdef\\leak{42}\\leak', false);

    // An undefined macro renders as red command text (throwOnError: false), not as an error
    // node, so check what the next expression shows: never the leaked definition.
    const next = renderMaths('\\leak', false);
    expect(
      next.kind === 'rendered' ? next.fragment.textContent : '',
    ).not.toContain('42');
  });

  it.each([
    '\\color{#000}{x}',
    'a \\color{red} x',
    '\\textcolor{red}{x}',
    '\\colorbox{red}{x}',
    '\\fcolorbox{red}{blue}{x}',
  ])(
    'paints no sender colour for %s, keeping the content (decision 13)',
    (latex) => {
      const fragment = rendered(latex);
      const painted = [...fragment.querySelectorAll('*')].filter(
        (element) =>
          element.hasAttribute('mathcolor') ||
          element.hasAttribute('mathbackground') ||
          /(?:^|;)\s*(?:color|background-color|border-color)\s*:/i.test(
            element.getAttribute('style') ?? '',
          ),
      );

      expect(painted).toEqual([]);
      expect(fragment.querySelector('.katex-html')?.textContent).toContain('x');
    },
  );

  it('writes nothing to the console, which feeds the diagnostic log', () => {
    const levels = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
    );

    // Non-ASCII text in maths mode is a strict-mode warning by default.
    renderMaths('é + \\text{café}', false);
    renderMaths('\\frac{1}{', false);
    // TeX's terminal commands log whatever strict and trust say, unless replaced.
    renderMaths('\\message{secret}x', false);
    renderMaths('\\errmessage{secret}x', false);
    renderMaths('\\show\\frac x', false);

    for (const level of levels) {
      expect(level).not.toHaveBeenCalled();
    }
  });
});
