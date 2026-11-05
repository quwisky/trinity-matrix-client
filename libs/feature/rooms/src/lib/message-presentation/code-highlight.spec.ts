import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import {
  MAX_CODE_CHARS,
  MAX_LINE_CHARS,
  highlightLines,
  linesFromRuns,
  registerLanguage,
} from './code-highlight';
import { resolveLanguage } from './code-languages';
import { GRAMMAR_SAMPLES } from './code-highlight.samples';

/** Highlight a fenced block the way the render path does, and hand back the <code>. */
async function highlight(lang: string, source: string): Promise<HTMLElement> {
  const entry = resolveLanguage(lang);
  if (entry) {
    registerLanguage(entry.id, (await entry.load()).default);
  }
  const el = document.createElement('div');
  el.innerHTML = sanitizeMatrixHtml(
    `<pre><code class="language-${lang}">${source
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')}</code></pre>`,
  );
  const code = el.querySelector('code') as HTMLElement;
  const lines = highlightLines(source, entry?.id ?? lang, document);
  if (lines) {
    // Same placement the directive uses: into the sanitizer's line wrappers.
    const wrappers = [...code.children];
    wrappers.forEach((wrapper, i) => wrapper.replaceChildren(lines[i]));
    if (wrappers.length === 0) {
      code.replaceChildren(
        ...lines.flatMap((line, i) =>
          i ? [document.createTextNode('\n'), line] : [line],
        ),
      );
    }
  }
  return code;
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
  it('colours keywords, strings, comments and numbers', async () => {
    const code = await highlight(
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

  it('reproduces the source exactly, character for character', async () => {
    // The assertion that matters most: tokenizing must not lose, add or reorder a single
    // character of someone's code.
    const source =
      'const x: string = f(1);\n\tif (a && b) {\n  return `t${x}`;\n}\n';
    const code = await highlight('typescript', source);

    expect(code.textContent).toBe(source);
  });

  // One sample per grammar, in that grammar's own syntax — a JS-ish sample is a false
  // negative for diff, ini or makefile, which is exactly how an earlier survey of this
  // set concluded they were unsupported. A grammar that stops resolving (a renamed
  // highlight.js language, a dropped import) shows up here as a language with no tokens
  // rather than as a silently plain block in someone's room. One case per grammar, so each
  // grammar's first compile has its own timeout rather than all of them sharing one.
  it.each(GRAMMAR_SAMPLES)('highlights %s', async (lang, source) => {
    expect(roles(await highlight(lang, source)).length).toBeGreaterThan(0);
  });

  it('resolves short language aliases', async () => {
    // ```js and ```py are far more common in the wild than the canonical names.
    for (const [alias, source] of [
      ['js', 'const a = 1;'],
      ['ts', 'let b: number = 2;'],
      ['py', 'x = 3'],
      ['yml', 'a: 1'],
      ['sh', 'echo hi'],
    ] as const) {
      expect(
        roles(await highlight(alias, source)).length,
        alias,
      ).toBeGreaterThan(0);
    }
  });

  it('leaves an unknown language as plain text', async () => {
    const code = await highlight('nosuchlang', 'whatever this is');

    expect(roles(code)).toEqual([]);
    expect(code.textContent).toBe('whatever this is');
  });

  it('leaves an oversized block unhighlighted rather than freezing the timeline', async () => {
    const code = await highlight(
      'typescript',
      'const a = 1;\n'.repeat(Math.ceil(MAX_CODE_CHARS / 12) + 1),
    );

    expect(roles(code)).toEqual([]);
  });

  it('never emits a style attribute', async () => {
    // Angular's [innerHTML] sanitizer drops `style` at the render leaf, so inline colours
    // would silently render as no colours at all. This is why we emit classes.
    const code = await highlight('typescript', 'const a = "b"; // c');

    expect(code.innerHTML).not.toContain('style');
    expect(code.querySelector('[style]')).toBeNull();
  });

  it('drops a class the sender put on their own markup, on any element', async () => {
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

  it('emits only token classes, never anything the sender could have injected', async () => {
    const code = await highlight('typescript', 'const a = 1;');

    // Deliberately the UNFILTERED list. Two class families are ours and both are added
    // after DOMPurify, which is why neither is in ALLOWED_CLASS: `tok-*` from the
    // highlighter and `code-line` from the line-wrapping pass. Anything else appearing here
    // came from the sender's markup and must not have survived.
    for (const token of allClasses(code)) {
      expect(token).toMatch(/^(?:tok-[a-z]+|code-line)$/);
    }
  });

  it('skips a block with a line over 1,000 characters', async () => {
    const source = 'const a = 1; ' + 'x'.repeat(MAX_LINE_CHARS);
    const code = await highlight('typescript', source);

    expect(roles(code)).toEqual([]);
    expect(code.textContent).toBe(source);
  });

  it('splits a multi-line comment into one coloured run per line', async () => {
    const source = '/* one\ntwo */\nlet a = 1;';
    await highlight('javascript', source);
    const lines = highlightLines(source, 'javascript', document);

    expect(lines).toHaveLength(3);
    for (const line of lines?.slice(0, 2) ?? []) {
      expect(line.querySelector('span.tok-comment')).not.toBeNull();
    }
  });

  it('keeps tag-like content in an HTML fence as text', async () => {
    const source = '<img src=x onerror=alert(1)>';
    const code = await highlight('html', source);

    expect(code.querySelector('img')).toBeNull();
    expect(code.textContent).toBe(source);
  });

  it('round-trips <, >, & and quotes', async () => {
    const source = 'const s = "<a> & \'b\'";';
    const code = await highlight('typescript', source);

    expect(code.textContent).toBe(source);
  });

  it('keeps CRLF text and line count', async () => {
    await highlight('python', 'x = 1');
    const lines = highlightLines('a = 1\r\nb = 2', 'python', document);

    expect(lines).toHaveLength(2);
    expect(lines?.map((line) => line.textContent).join('\n')).toBe(
      'a = 1\r\nb = 2',
    );
  });

  it('leaves an empty or blank fence plain', async () => {
    await highlight('python', 'x = 1');

    expect(highlightLines('', 'python', document)).toBeNull();
    expect(highlightLines('  \n ', 'python', document)).toBeNull();
  });

  it('returns null for a language that is not registered', () => {
    expect(highlightLines('x', 'lua-not-loaded', document)).toBeNull();
  });

  it('builds lines from runs', () => {
    const lines = linesFromRuns(
      [
        [
          ['let', 'keyword'],
          [' a', null],
        ],
      ],
      'let a',
      document,
    );

    expect(lines).toHaveLength(1);
    expect(lines?.[0].querySelector('span.tok-keyword')?.textContent).toBe(
      'let',
    );
    expect(lines?.[0].textContent).toBe('let a');
  });

  it('rejects runs whose text differs from the code', () => {
    expect(linesFromRuns([[['let', null]]], 'var', document)).toBeNull();
  });

  it('restores CR from runs', () => {
    const lines = linesFromRuns(
      [[['a = 1', null]], [['b = 2', null]]],
      'a = 1\r\nb = 2',
      document,
    );

    expect(lines?.map((line) => line.textContent).join('\n')).toBe(
      'a = 1\r\nb = 2',
    );
  });
});
