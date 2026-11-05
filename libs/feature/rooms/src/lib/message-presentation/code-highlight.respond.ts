import hljs from 'highlight.js/lib/core';
import type {
  HighlightReply,
  HighlightRequest,
  HighlightResult,
} from './code-highlight.client';
import { languageById } from './code-languages';
import { fitsCaps, tokenize } from './code-tokens';

/** One load per grammar at a time, so requests waiting on the same first load share it. */
const loading = new Map<string, Promise<void>>();

function ensureGrammar(id: string): Promise<void> | null {
  if (hljs.getLanguage(id)) return Promise.resolve();
  const language = languageById(id);
  if (!language) return null;
  let pending = loading.get(id);
  if (!pending) {
    pending = language
      .load()
      .then((module) => {
        if (!hljs.getLanguage(id)) hljs.registerLanguage(id, module.default);
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

/**
 * The highlight worker's answer to one block: runs, plain (nothing to colour, or the output was
 * not what highlight.js emits), or retry (its grammar failed to load). Never rejects.
 */
export async function respond(
  request: HighlightRequest,
): Promise<HighlightReply> {
  const reply = (result: HighlightResult): HighlightReply => ({
    seq: request.seq,
    result,
  });
  if (!fitsCaps(request.code)) return reply({ kind: 'plain' });
  const grammar = ensureGrammar(request.id);
  if (!grammar) return reply({ kind: 'plain' });
  try {
    await grammar;
  } catch {
    return reply({ kind: 'retry' });
  }
  try {
    const lines = tokenize(
      hljs.highlight(request.code, {
        language: request.id,
        ignoreIllegals: true,
      }).value,
    );
    return reply(lines ? { kind: 'lines', lines } : { kind: 'plain' });
  } catch {
    return reply({ kind: 'plain' });
  }
}
