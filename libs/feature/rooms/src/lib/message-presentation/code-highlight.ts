import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from './code-languages';
import { linesFromRuns } from './code-lines';
import { fitsCaps, tokenize } from './code-tokens';

/**
 * Syntax highlighting for fenced code blocks, applied at the render leaf by CodeHighlightDirective.
 *
 * Never imported statically: the directive loads this module (highlight.js core) the first time a
 * rendered message holds a fenced block in a known language, then each grammar on first use
 * through `code-languages.ts`. A room without code downloads none of it.
 */

export { MAX_CODE_CHARS, MAX_LINE_CHARS } from './code-tokens';
export { linesFromRuns } from './code-lines';

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
