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

/** Every individual class token across the highlighted spans (a span may carry two). */
const roles = (code: HTMLElement) =>
  [...code.querySelectorAll('span')].flatMap((s) => s.className.split(' '));

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

  it('emits only token classes, never anything the sender could have injected', () => {
    const code = highlight('typescript', 'const a = 1;');

    for (const className of roles(code)) {
      for (const token of className.split(' ')) {
        expect(token).toMatch(/^tok-[a-z]+$/);
      }
    }
  });
});
