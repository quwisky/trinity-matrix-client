import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import katex from 'katex';
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

/** Every `style` in document order, as `property:value` declarations joined by `;`. */
function styleDeclarations(root: ParentNode): string[] {
  return [...root.querySelectorAll('[style]')].map((element) =>
    (element.getAttribute('style') ?? '')
      .split(';')
      .map((declaration) => declaration.replace(/\s*:\s*/, ':').trim())
      .filter(Boolean)
      .join(';'),
  );
}

/** KaTeX's own markup for `latex`, parsed but never sanitized (test reference only). */
function unsanitized(latex: string, displayMode: boolean): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = katex.renderToString(latex, {
    displayMode,
    maxSize: 10,
    throwOnError: false,
    strict: 'ignore',
    output: 'htmlAndMathml',
  });
  return template.content;
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

  it('keeps the line KaTeX draws for a cancelled term', () => {
    expect(rendered('\\cancel{x}').querySelector('svg line')).not.toBeNull();
  });

  it.each([
    '\\href{https://x}{click}',
    '\\foo',
    '\\htmlStyle{color:red}{x}',
    '\\url{https://evil.example}',
    '\\includegraphics{https://evil.example/x.png}',
    '\\htmlClass{x}{y}',
  ])(
    "shows the source, not KaTeX's red error text, for %s (T14-2)",
    (latex) => {
      // KaTeX paints an unknown or untrusted command in its error colour, below 3:1 on dark
      // themes, and drops the command's text; the reader gets the LaTeX instead.
      expect(renderMaths(latex, false).kind).toBe('source');
    },
  );

  it('shows the source when only the HTML copy holds an error', () => {
    // \html@mathml{A}{B} draws A and gives screen readers B: no `mathcolor` in the MathML.
    expect(renderMaths('\\html@mathml{\\foo}{x}', false).kind).toBe('source');
  });

  it('renders TeX whose text merely spells the error colour', () => {
    const fragment = rendered(
      '\\text{style="color:\\#cc0000" color:\\#cc0000} + 1',
    );

    expect(fragment.querySelector('.katex-html')?.textContent).toContain(
      'color:#cc0000',
    );
  });

  it.each([
    ['\\text{<script>alert(1)</script>}', 'rendered'],
    ['\\text{<img src=x onerror=alert(1)>}', 'rendered'],
    ['\\href{javascript:alert(1)}{x}', 'source'],
    ['\\htmlStyle{background:url(https://evil.example/x)}{x}', 'source'],
    ['\\color{red;background:url(https://evil.example/x)}{x}', 'rendered'],
    [
      '\\text{<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>}',
      'rendered',
    ],
  ] as const)(
    'lets no code or network reference through from the maths payload %s',
    (latex, kind) => {
      const outcome = renderMaths(latex, false);

      expect(outcome.kind).toBe(kind);
      expect(
        outcome.kind === 'rendered' ? dangerous(outcome.fragment) : [],
      ).toEqual([]);
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

  it('keeps only the inline styles KaTeX writes, with plain lengths', () => {
    const fragment = sanitizeMathsMarkup(
      '<span style="height:0.43em;vertical-align:-0.2em;display:none;color:red;' +
        'position:fixed;width:calc(100vw);margin:0 -0.02em">a</span>' +
        '<span style="color:transparent">b</span>' +
        '<span style="background:red;z-index:9">c</span>',
    );
    const [first, second, third] = fragment.querySelectorAll('span');

    expect(first.getAttribute('style')).toBe(
      'height:0.43em;vertical-align:-0.2em;margin:0 -0.02em',
    );
    // \phantom hides its content with a transparent colour, the one colour KaTeX may keep.
    expect(second.getAttribute('style')).toBe('color:transparent');
    expect(third.hasAttribute('style')).toBe(false);
  });

  it.each([
    '\\cancel{x} \\sqrt[3]{x} \\sout{abc} \\boxed{x} \\pmb{x} \\phantom{x}y',
    '\\xrightarrow{abc} \\widehat{abc} \\overbrace{a+b}^{n} \\phase{-78^\\circ}',
    '\\left(\\frac{\\frac{a}{b}}{c}\\right) \\Bigg[ \\raisebox{0.5em}{x} \\rule{1em}{2em}',
    '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\begin{array}{c|c:c}a&b&c\\\\\\hline d&e&f\\end{array}',
    'a \\\\[1em] b \\kern-1em c \\mathllap{d} \\angl{n} \\cancel{\\frac{a}{b}}',
    '\\int_0^1 x^2 \\, dx \\sum_{i=0}^n i \\oiint \\vec{x} \\textcircled{a} x^{2^{3}}_{i_j}',
  ])('keeps every style KaTeX writes for %s', (latex) => {
    for (const displayMode of [false, true]) {
      expect(styleDeclarations(rendered(latex, displayMode))).toEqual(
        styleDeclarations(unsanitized(latex, displayMode)),
      );
    }
  });

  it('keeps its markup while the message sanitizer hooks the default DOMPurify instance', () => {
    // Loading message-view registers its per-tag table on the default instance, which strips
    // every class and style outside it; the maths sanitizer must not share that instance.
    expect(
      sanitizeMatrixHtml('<span class="katex" style="width:1em">x</span>'),
    ).not.toMatch(/\b(?:class|style)=/);

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

  it.each([
    'a\\kern{-40em}\\text{Bob: fake}',
    '\\smash{\\raisebox{-30em}{\\text{fake}}}',
    '\\raisebox{10em}{\\raisebox{10em}{x}}',
    '\\hspace{-20em}x',
    '\\mkern-200mu x',
    '\\rule[-20em]{1em}{1em}',
  ])(
    'shows the source for %s, which would draw outside the formula (T17-1)',
    (latex) => {
      // KaTeX's maxSize caps only positive sizes; a kern, raise or shift moving content more
      // than 10em either way would draw over other messages.
      expect(renderMaths(latex, false).kind).toBe('source');
    },
  );

  it.each([
    ['\\!x', false],
    ['\\kern-0.5em x', false],
    ['\\mathllap{x}', false],
    ['\\raisebox{0.5em}{x}', false],
    ['\\frac{a}{b}', false],
    ['\\sum_{i=1}^{n} i', true],
    ['\\begin{pmatrix}1&2&3\\\\4&5&6\\\\7&8&9\\end{pmatrix}', true],
    ['\\begin{aligned}a&=1\\\\b&=2\\\\c&=3\\\\d&=4\\end{aligned}', true],
    ['\\underbrace{a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p}_{16}', true],
    ['x \\xrightarrow{\\text{a very long label over the arrow}} y', true],
    [
      `\\begin{aligned}${Array.from({ length: 10 }, (_, row) => `a_{${row}}&=${row}`).join('\\\\')}\\end{aligned}`,
      true,
    ],
    [
      `\\begin{pmatrix}${Array.from({ length: 10 }, (_, row) =>
        Array.from({ length: 10 }, (_, column) => row * column).join('&'),
      ).join('\\\\')}\\end{pmatrix}`,
      true,
    ],
    // Each move stays within the bound; the stylesheet's clip holds their sum inside the
    // formula (rendered-markdown.scss).
    ['\\kern{-9em}\\kern{-9em}\\text{fake}', false],
    ['\\smash{\\raisebox{-9em}{\\raisebox{-9em}{\\text{fake}}}}', false],
  ])('renders %s, which moves nothing further than 10em', (latex, display) => {
    expect(renderMaths(latex, display).kind).toBe('rendered');
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
