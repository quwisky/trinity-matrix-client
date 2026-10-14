import DOMPurify from 'dompurify';
import katex from 'katex';

/**
 * KaTeX for maths in messages (spec B, Matrix spec v1.11 "Mathematical messages").
 *
 * Never imported statically: MathsDirective loads this module with a dynamic `import()` the
 * first time a rendered body holds maths, so KaTeX (about 270 KB minified) is a lazy chunk and
 * a room without maths never downloads it.
 */

/** Characters of LaTeX one expression may have; past it the source is shown. */
export const MAX_MATHS_SOURCE_LENGTH = 2_000;

/** What became of one expression: KaTeX's sanitized markup, or "show the source". */
export type MathsOutcome =
  | { readonly kind: 'rendered'; readonly fragment: DocumentFragment }
  | { readonly kind: 'source' };

// Its own instance: the default one carries message-view.ts's Matrix hook, which would strip
// KaTeX's classes and styles. Defence in depth — `trust: false` already keeps URLs out.
const purifier = DOMPurify(window);

// No URL in an inline style (owner decision 10): KaTeX never writes `url(…)`, `image-set`,
// `cross-fade`, `element(…)` or a CSS escape (which could spell `u\rl(`), and they are the ways a
// style attribute reaches the network. A fixed pattern, never built from the input.
const STYLE_URL = /\\|url\s*\(|image-set|cross-fade|element\s*\(/i;
purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && STYLE_URL.test(data.attrValue)) {
    data.keepAttr = false;
  }
});

const MATHS_PURIFY_CONFIG = {
  // No SVG profile: only the SVG KaTeX emits is added below (owner decision 10).
  USE_PROFILES: { html: true, mathMl: true },
  ADD_TAGS: [
    // DOMPurify disallows these MathML elements by default; KaTeX wraps its MathML in them
    // and keeps the LaTeX in the annotation, which is what screen readers are given.
    'semantics',
    'annotation',
    // KaTeX's SvgNode, PathNode and LineNode (stretchy delimiters, \sqrt, \cancel).
    'svg',
    'path',
    'line',
  ],
  // DOMPurify compares attribute names in lower case.
  ADD_ATTR: [
    'encoding',
    'viewbox',
    'preserveaspectratio',
    'd',
    'x1',
    'y1',
    'x2',
    'y2',
    'stroke-width',
  ],
  FORBID_TAGS: [
    'a',
    'img',
    'image',
    'use',
    'foreignObject',
    'script',
    'style',
    'form',
    'iframe',
  ],
  FORBID_ATTR: [
    'href',
    'xlink:href',
    'src',
    'srcset',
    'action',
    'formaction',
    'background',
    'poster',
  ],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true as const,
};

/**
 * KaTeX built-ins replaced for every call; `renderMaths` copies them into a fresh table.
 * - `\message`, `\errmessage` and `\show` write to the console whatever `strict` and `trust`
 *   say, and console output feeds the diagnostic log, which must never hold message content.
 * - `\color`, `\textcolor` and `\colorbox` (owner decision 13) and `\fcolorbox` (decision 2)
 *   would paint sender colours past the 3:1 contrast guard; they keep only their content.
 * `\@firstoftwo{A}{B}` expands to `A`; naming every `#n` keeps KaTeX's argument count right.
 */
const NEUTRALISED_MACROS: Readonly<Record<string, string>> = {
  '\\message': '\\@firstoftwo{}{#1}',
  '\\errmessage': '\\@firstoftwo{}{#1}',
  '\\show': '\\@firstoftwo{}{#1}',
  '\\color': '\\@firstoftwo{}{#1}',
  '\\textcolor': '\\@firstoftwo{{#2}}{#1}',
  '\\colorbox': '\\@firstoftwo{\\text{#2}}{#1}',
  '\\fcolorbox': '\\@firstoftwo{\\text{#3}}{#1#2}',
};

/**
 * KaTeX's markup through the maths-only DOMPurify instance: HTML, MathML and the minimal SVG
 * KaTeX emits; no script, `foreignObject`, event handlers, links or URLs anywhere.
 */
export function sanitizeMathsMarkup(markup: string): DocumentFragment {
  return purifier.sanitize(markup, MATHS_PURIFY_CONFIG);
}

/**
 * Render one expression. KaTeX's options are the spec's: no trusted commands (`\href`, `\url`,
 * `\includegraphics`, `\html*`), sizes up to 10em, at most 100 macro expansions, warnings
 * ignored (console warnings feed the diagnostic log, which must never hold message content),
 * and a fresh macro table for every call, seeded with {@link NEUTRALISED_MACROS}, so a `\gdef`
 * cannot leak into the next expression or message. Anything KaTeX rejects, or an expression over {@link MAX_MATHS_SOURCE_LENGTH},
 * becomes `{ kind: 'source' }`.
 */
export function renderMaths(latex: string, displayMode: boolean): MathsOutcome {
  if (latex.length === 0 || latex.length > MAX_MATHS_SOURCE_LENGTH) {
    return { kind: 'source' };
  }
  let markup: string;
  try {
    markup = katex.renderToString(latex, {
      displayMode,
      trust: false,
      maxSize: 10,
      maxExpand: 100,
      throwOnError: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      // A fresh table per call, so a `\gdef` cannot leak into the next expression.
      macros: { ...NEUTRALISED_MACROS },
    });
  } catch {
    return { kind: 'source' };
  }
  const fragment = sanitizeMathsMarkup(markup);
  if (
    fragment.querySelector('.katex-error') ||
    !fragment.querySelector('.katex')
  ) {
    return { kind: 'source' };
  }
  return { kind: 'rendered', fragment };
}
