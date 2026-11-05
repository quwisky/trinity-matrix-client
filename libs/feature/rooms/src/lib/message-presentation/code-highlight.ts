import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from './code-languages';
import { roleOfClasses, type TokenRole } from './code-tokens';

/**
 * Syntax highlighting for fenced code blocks, applied at the render leaf by CodeHighlightDirective.
 *
 * Never imported statically: the directive loads this module (highlight.js core) the first time a
 * rendered message holds a fenced block in a known language, then each grammar on first use
 * through `code-languages.ts`. A room without code downloads none of it.
 */

/**
 * Ceiling on what we will tokenize. Highlighting runs synchronously on the main thread and a sender
 * can put a 60 KiB fenced block in every event. Past the cap the block renders as plain monospace.
 */
export const MAX_CODE_CHARS = 4_096;

/** One minified line can cost more than many short ones; past this, the block stays plain. */
export const MAX_LINE_CHARS = 1_000;

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
 * language is not registered, the block is blank or oversized, or highlighting fails. No token
 * spans a newline, so a caller may wrap each fragment in its own line.
 *
 * highlight.js returns markup, which is parsed in a document that is never attached and read only
 * as data: text nodes and allowlisted classes. The live DOM is built with createElement and
 * createTextNode, so no string can become markup here.
 */
export function highlightLines(
  code: string,
  id: string,
  doc: Document,
): DocumentFragment[] | null {
  if (
    !code.trim() ||
    code.length > MAX_CODE_CHARS ||
    code.split('\n').some((line) => line.length > MAX_LINE_CHARS) ||
    !isRegistered(id)
  ) {
    return null;
  }
  try {
    const { value } = hljs.highlight(code, {
      language: id,
      ignoreIllegals: true,
    });
    const parsed = new DOMParser().parseFromString(
      `<body>${value}</body>`,
      'text/html',
    );
    const lines = [doc.createDocumentFragment()];
    collect(parsed.body, null, lines, doc);
    // HTML parsing turns CRLF into LF; give each line its carriage return back.
    const sourceLines = code.split('\n');
    sourceLines.forEach((line, i) => {
      if (line.endsWith('\r')) lines[i]?.appendChild(doc.createTextNode('\r'));
    });
    // The rebuilt text must be the sender's code exactly; anything else renders plain.
    const text = lines.map((line) => line.textContent).join('\n');
    return text === code ? lines : null;
  } catch {
    // A grammar tripping over one input degrades that block to plain code.
    return null;
  }
}

/** Append `node`'s text to `lines`, starting a new fragment at each newline. */
function collect(
  node: Node,
  inherited: TokenRole | null,
  lines: DocumentFragment[],
  doc: Document,
): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const role =
        roleOfClasses([...(child as Element).classList]) ?? inherited;
      collect(child, role, lines, doc);
    } else if (child.nodeType === Node.TEXT_NODE) {
      (child.textContent ?? '').split('\n').forEach((piece, i) => {
        if (i > 0) lines.push(doc.createDocumentFragment());
        if (piece)
          lines[lines.length - 1].appendChild(run(piece, inherited, doc));
      });
    }
  }
}

function run(text: string, role: TokenRole | null, doc: Document): Node {
  if (!role) return doc.createTextNode(text);
  const span = doc.createElement('span');
  span.className =
    role === 'comment' ? 'tok-comment tok-italic' : `tok-${role}`;
  span.textContent = text;
  return span;
}
