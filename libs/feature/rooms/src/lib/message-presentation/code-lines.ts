import type { Run, TokenRole } from './code-tokens';

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
