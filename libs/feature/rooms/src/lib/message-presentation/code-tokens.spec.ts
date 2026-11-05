import hljs from 'highlight.js/lib/core';
import { describe, expect, it } from 'vitest';
import { GRAMMAR_SAMPLES } from './code-highlight.samples';
import { resolveLanguage } from './code-languages';
import { tokenize, type Run } from './code-tokens';

const text = (lines: Run[][]) =>
  lines.map((line) => line.map(([t]) => t).join('')).join('\n');

describe('tokenize', () => {
  it('round-trips real highlight.js output for every grammar sample', async () => {
    for (const [fence, source] of GRAMMAR_SAMPLES) {
      const language = resolveLanguage(fence);
      expect(language, fence).not.toBeNull();
      if (!language) continue;
      if (!hljs.getLanguage(language.id)) {
        hljs.registerLanguage(language.id, (await language.load()).default);
      }
      const { value } = hljs.highlight(source, {
        language: language.id,
        ignoreIllegals: true,
      });
      const lines = tokenize(value);

      expect(lines, fence).not.toBeNull();
      expect(text(lines ?? []), fence).toBe(source);
    }
  });

  it('keeps the innermost mapped role', () => {
    expect(
      tokenize(
        '<span class="hljs-meta"><span class="hljs-keyword">import</span> x</span>',
      ),
    ).toEqual([
      [
        ['import', 'keyword'],
        [' x', null],
      ],
    ]);
  });

  it('splits a span across lines', () => {
    expect(tokenize('<span class="hljs-comment">/* a\nb */</span>')).toEqual([
      [['/* a', 'comment']],
      [['b */', 'comment']],
    ]);
  });

  it('decodes the five escapes', () => {
    expect(tokenize('&lt;a&gt; &amp; &quot;b&quot; &#x27;c&#x27;')).toEqual([
      [['<a> & "b" \'c\'', null]],
    ]);
  });

  it('rejects anything else', () => {
    for (const html of [
      '<img src=x>',
      '<span onclick="x">a</span>',
      '&#60;',
      'a & b',
      '<span class="hljs-string">a',
      '</span>',
    ]) {
      expect(tokenize(html), html).toBeNull();
    }
  });
});
