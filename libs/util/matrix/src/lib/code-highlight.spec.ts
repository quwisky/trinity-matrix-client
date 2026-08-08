import { afterAll, describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml, setCodeHighlighter } from './message-view';
// Importing the module registers the real highlighter by side effect — the same way the
// lazily-loaded rooms route does it in the app.
import './code-highlight';

/** Highlight a fenced block the way the render path does, and hand back the <code>. */
function highlight(lang: string, source: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = sanitizeMatrixHtml(
    `<pre><code class="language-${lang}">${source
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')}</code></pre>`,
  );
  return el.querySelector('code') as HTMLElement;
}

/** The line wrapper renderCodeBlocks adds; structural, not a colouring role. */
const CODE_LINE = 'code-line';

/** Every individual class token across the spans in a block (a span may carry two). */
const allClasses = (code: HTMLElement) =>
  [...code.querySelectorAll('span')].flatMap((s) => s.className.split(' '));

/**
 * The COLOURING roles only.
 *
 * Every block is wrapped line by line so the numbering gutter has something to hang off, so
 * "no spans at all" stopped being the same statement as "nothing was highlighted". Filtering
 * the wrapper keeps the tests below saying what they mean; the injection guard checks the
 * unfiltered list, so an unexpected class still has nowhere to hide.
 */
const roles = (code: HTMLElement) =>
  allClasses(code).filter((token) => token !== CODE_LINE);

describe('code highlighting', () => {
  afterAll(() => {
    // Module-scoped registration; setCodeHighlighter also clears the sanitize memo,
    // which is process-lived and would otherwise leak highlighted output into later specs.
    setCodeHighlighter(null);
  });

  it('colours keywords, strings, comments and numbers', () => {
    const code = highlight(
      'python',
      'def greet(n):  # hi\n    return "x" + str(42)',
    );

    expect(roles(code)).toEqual(
      expect.arrayContaining([
        'tok-keyword',
        'tok-string',
        'tok-comment',
        'tok-number',
        'tok-function',
        // The only font style any theme rule sets — kept live rather than mapping flags
        // nothing produces.
        'tok-italic',
      ]),
    );
  });

  it('reproduces the source exactly, character for character', () => {
    // The assertion that matters most: tokenizing must not lose, add or reorder a single
    // character of someone's code.
    const source =
      'const x: string = f(1);\n\tif (a && b) {\n  return `t${x}`;\n}\n';
    const code = highlight('typescript', source);

    expect(code.textContent).toBe(source);
  });

  it('resolves short language aliases', () => {
    // ```js and ```py are far more common in the wild than the canonical names.
    for (const [alias, source] of [
      ['js', 'const a = 1;'],
      ['ts', 'let b: number = 2;'],
      ['py', 'x = 3'],
      ['yml', 'a: 1'],
      ['sh', 'echo hi'],
    ] as const) {
      expect(roles(highlight(alias, source)).length, alias).toBeGreaterThan(0);
    }
  });

  it('leaves an unknown language as plain text', () => {
    const code = highlight('nosuchlang', 'whatever this is');

    expect(roles(code)).toEqual([]);
    expect(code.textContent).toBe('whatever this is');
  });

  it('leaves an oversized block unhighlighted rather than freezing the timeline', () => {
    const code = highlight('typescript', 'const a = 1;\n'.repeat(1000));

    expect(roles(code)).toEqual([]);
  });

  it('never emits a style attribute', () => {
    // Angular's [innerHTML] sanitizer drops `style` at the render leaf, so inline colours
    // would silently render as no colours at all. This is why we emit classes.
    const code = highlight('typescript', 'const a = "b"; // c');

    expect(code.innerHTML).not.toContain('style');
    expect(code.querySelector('[style]')).toBeNull();
  });

  it('drops a class the sender put on their own markup, on any element', () => {
    // The guard below cannot express this: `highlight()` escapes < and >, so its input can
    // never contain sender markup, and it only inspects <span>. This feeds real markup
    // straight to the sanitizer and checks EVERY element, which is what actually fails if
    // ALLOWED_CLASS regresses — the defence is DOMPurify's, not the highlighter's.
    const host = document.createElement('div');
    host.innerHTML = sanitizeMatrixHtml(
      '<pre><code class="language-typescript">' +
        '<span class="evil">const</span> <a class="mx-spoiler evil" href="https://e.example">a</a>' +
        '</code></pre>',
    );

    for (const el of host.querySelectorAll('*')) {
      for (const token of el.className.toString().split(' ').filter(Boolean)) {
        expect(token).toMatch(
          /^(?:tok-[a-z]+|code-line|language-[\w-]+|mx-spoiler)$/,
        );
      }
    }
  });

  it('emits only token classes, never anything the sender could have injected', () => {
    const code = highlight('typescript', 'const a = 1;');

    // Deliberately the UNFILTERED list. Two class families are ours and both are added
    // after DOMPurify, which is why neither is in ALLOWED_CLASS: `tok-*` from the
    // highlighter and `code-line` from the line-wrapping pass. Anything else appearing here
    // came from the sender's markup and must not have survived.
    for (const token of allClasses(code)) {
      expect(token).toMatch(/^(?:tok-[a-z]+|code-line)$/);
    }
  });
});
