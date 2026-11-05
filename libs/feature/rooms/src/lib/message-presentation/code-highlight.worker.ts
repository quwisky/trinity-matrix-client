import hljs from 'highlight.js/lib/core';
import type { HighlightReply, HighlightRequest } from './code-highlight.client';
import { languageById } from './code-languages';
import { fitsCaps, tokenize } from './code-tokens';

/**
 * Tokenizes code blocks off the main thread. Each request names a highlight.js id; its grammar
 * loads on first use. Replies carry runs, never markup: the main thread builds the DOM and checks
 * the text against the code it sent.
 */
const scope = self as unknown as {
  postMessage(reply: HighlightReply): void;
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
};

async function highlight({
  id,
  code,
}: HighlightRequest): Promise<HighlightReply['lines']> {
  if (!fitsCaps(code)) return null;
  if (!hljs.getLanguage(id)) {
    const language = languageById(id);
    if (!language) return null;
    const grammar = (await language.load()).default;
    // Two requests can wait on the same first load.
    if (!hljs.getLanguage(id)) hljs.registerLanguage(id, grammar);
  }
  return tokenize(
    hljs.highlight(code, { language: id, ignoreIllegals: true }).value,
  );
}

scope.onmessage = ({ data }) => {
  highlight(data).then(
    (lines) => scope.postMessage({ seq: data.seq, lines }),
    () => scope.postMessage({ seq: data.seq, lines: null }),
  );
};
