import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from './code-languages';
import { fitsCaps, tokenize, type Run, type TokenRole } from './code-tokens';

/**
 * Syntax highlighting for fenced code blocks, applied at the render leaf by CodeHighlightDirective.
 *
 * Never imported statically: the directive loads this module (highlight.js core) the first time a
 * rendered message holds a fenced block in a known language, then each grammar on first use
 * through `code-languages.ts`. A room without code downloads none of it.
 */

export { MAX_CODE_CHARS, MAX_LINE_CHARS } from './code-tokens';

/** Add a loaded grammar; registering the same id again is a no-op. */
export function registerLanguage(id: string, grammar: LanguageFn): void {
  if (!hljs.getLanguage(id)) {
    hljs.registerLanguage(id, grammar);
  }
}

export function isRegistered(id: string): boolean {
  return hljs.getLanguage(id) !== undefined;
}

/**
 * Tokenize `code` into one fragment per line of `<span class="tok-*">` runs, or null when the
 * language is not registered, the block is blank or oversized, or highlighting fails. The main
 * thread's path, used when the highlight worker is unavailable.
 */
export function highlightLines(
  code: string,
  id: string,
  doc: Document,
): DocumentFragment[] | null {
  if (!fitsCaps(code) || !isRegistered(id)) {
    return null;
  }
  try {
    const { value } = hljs.highlight(code, {
      language: id,
      ignoreIllegals: true,
    });
    const runs = tokenize(value);
    return runs ? linesFromRuns(runs, code, doc) : null;
  } catch {
    // A grammar tripping over one input degrades that block to plain code.
    return null;
  }
}

/**
 * One fragment per line of `<span class="tok-*">` runs, built with createElement and
 * createTextNode, or null unless the text is exactly `code`. No token spans a newline, so a
 * caller may wrap each fragment in its own line.
 */
export function linesFromRuns(
  runs: readonly (readonly Run[])[],
  code: string,
  doc: Document,
): DocumentFragment[] | null {
  const sourceLines = code.split('\n');
  const lines = runs.map((line, i) => {
    const fragment = doc.createDocumentFragment();
    for (const [text, role] of line) {
      fragment.appendChild(node(text, role, doc));
    }
    // Runs that dropped the CR of a CRLF get it back; the text check below still decides.
    if (
      sourceLines[i]?.endsWith('\r') &&
      !fragment.textContent?.endsWith('\r')
    ) {
      fragment.appendChild(doc.createTextNode('\r'));
    }
    return fragment;
  });
  // The rebuilt text must be the sender's code exactly; anything else renders plain.
  const text = lines.map((line) => line.textContent).join('\n');
  return text === code ? lines : null;
}

function node(text: string, role: TokenRole | null, doc: Document): Node {
  if (!role) return doc.createTextNode(text);
  const span = doc.createElement('span');
  span.className =
    role === 'comment' ? 'tok-comment tok-italic' : `tok-${role}`;
  span.textContent = text;
  return span;
}
