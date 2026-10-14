import DOMPurify, { type Config } from 'dompurify';
import katex from 'katex';

/**
 * KaTeX for maths in messages (spec B, Matrix spec v1.11 "Mathematical messages").
 *
 * Never imported statically: MathsLoader (for MathsDirective) loads this module with a dynamic
 * `import()` the first time a rendered body holds maths, so KaTeX (about 270 KB minified) is a
 * lazy chunk and a room without maths never downloads it. The chunk is named after this file
 * (`maths-render-<hash>.js`), and `apps/trinity/ngsw-config.json` matches that name to keep it
 * out of the service worker's prefetch: renaming this file moves KaTeX back into prefetch.
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

/** KaTeX's colour for what it cannot render; see {@link renderMaths}. */
const ERROR_COLOUR = '#cc0000';

// Up to four plain lengths (`0.25em`, `0 -0.02em`, `0.02em 0.01em 0.04px`): no URL, function,
// keyword or CSS escape can match. A fixed pattern, never built from the input.
const LENGTHS =
  /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|px)?(?: -?(?:\d+(?:\.\d+)?|\.\d+)(?:em|px)?){0,3}$/;

/**
 * Every inline style KaTeX 0.19.0 writes, with the values it writes (owner decision 10). Its
 * layout uses plain lengths; `\phantom` hides content with `color: transparent`, the one colour
 * kept. Sender colours never reach here (they are neutralised) and `color: #cc0000` (errors) is
 * dropped. Derived from KaTeX's source and output (`\cancel`, `\sqrt[3]`, `\xrightarrow`,
 * `\widehat`, `\overbrace`, `\phase`, `\boxed`, `\pmb`, `\raisebox`, `\rule`, `\\[1em]`,
 * limits, accents, `\oiint`, large delimiters, matrices and arrays with rules); the spec's
 * "keeps every style KaTeX writes" cases fail if a property here is missing.
 */
const KATEX_STYLES: ReadonlyMap<string, RegExp> = new Map([
  ...[
    'height',
    'width',
    'min-width',
    'vertical-align',
    'top',
    'bottom',
    'left',
    'margin',
    'margin-top',
    'margin-left',
    'margin-right',
    'padding-left',
    'border-width',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'text-shadow',
  ].map((property) => [property, LENGTHS] as const),
  ['border-style', /^solid$/],
  ['border-right-style', /^(?:solid|dashed)$/],
  ['position', /^relative$/],
  ['color', /^transparent$/],
]);

// Inline styles keep only the declarations in KATEX_STYLES, one by one; a style left empty is
// removed. So no URL, `image-set`, CSS escape, sender colour or unknown property gets through.
purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName !== 'style') {
    return;
  }
  const kept = data.attrValue.split(';').flatMap((declaration) => {
    const colon = declaration.indexOf(':');
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    return colon > 0 && KATEX_STYLES.get(property)?.test(value)
      ? [`${property}:${value}`]
      : [];
  });
  if (kept.length > 0) {
    data.attrValue = kept.join(';');
  } else {
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
} satisfies Config;

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

// One `style="…"` attribute value of KaTeX's markup. KaTeX escapes `"` in text, attribute values
// and the MathML annotation (which repeats the sender's TeX), so this matches only real
// attributes, never text that spells one. A fixed pattern, never built from the input.
const STYLE_ATTRIBUTE = /\sstyle="([^"]*)"/g;

/**
 * Whether KaTeX painted anything in its error colour in the HTML copy, read from the raw markup
 * before the style allowlist drops the colour: `\html@mathml{\foo}{x}` keeps the error out of
 * the MathML copy. Only `style` attribute values are read, never text.
 */
function paintsErrorColour(markup: string): boolean {
  for (const [, style] of markup.matchAll(STYLE_ATTRIBUTE)) {
    const painted = style
      .split(';')
      .some(
        (declaration) =>
          declaration.replace(/\s+/g, '').toLowerCase() ===
          `color:${ERROR_COLOUR}`,
      );
    if (painted) {
      return true;
    }
  }
  return false;
}

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
 * cannot leak into the next expression or message. Anything KaTeX rejects, an expression over
 * {@link MAX_MATHS_SOURCE_LENGTH}, and anything KaTeX paints in its error colour (an unknown
 * command such as `\foo`, or one `trust: false` refuses, such as `\href`; red text below 3:1 on
 * dark themes that hides the command's content) becomes `{ kind: 'source' }`.
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
      errorColor: ERROR_COLOUR,
      // A fresh table per call, so a `\gdef` cannot leak into the next expression.
      macros: { ...NEUTRALISED_MACROS },
    });
  } catch {
    return { kind: 'source' };
  }
  if (paintsErrorColour(markup)) {
    return { kind: 'source' };
  }
  const fragment = sanitizeMathsMarkup(markup);
  // The MathML copy marks an error with `mathcolor`, which no sender can set (every colour
  // command is neutralised); `\html@mathml` can put one in the MathML copy alone.
  if (
    fragment.querySelector(`.katex-error, [mathcolor="${ERROR_COLOUR}"]`) ||
    !fragment.querySelector('.katex')
  ) {
    return { kind: 'source' };
  }
  return { kind: 'rendered', fragment };
}
