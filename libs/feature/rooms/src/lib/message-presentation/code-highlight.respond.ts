import hljs from 'highlight.js/lib/core';
import type {
  HighlightReply,
  HighlightRequest,
  HighlightResult,
  HighlightStarted,
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
 * Answer one block: `started` just before tokenizing, then its result (runs; plain when there is
 * nothing to colour or the output is not what highlight.js emits; retry when its grammar failed to
 * load). Each reply is posted in the same turn as its tokenizing, so a block's deadline never
 * covers another block's work. Never rejects.
 */
export async function respond(
  request: HighlightRequest,
  post: (message: HighlightReply | HighlightStarted) => void,
): Promise<void> {
  const reply = (result: HighlightResult): void =>
    post({ seq: request.seq, result });
  if (!fitsCaps(request.code)) return reply({ kind: 'plain' });
  const grammar = ensureGrammar(request.id);
  if (!grammar) return reply({ kind: 'plain' });
  try {
    await grammar;
  } catch {
    return reply({ kind: 'retry' });
  }
  post({ seq: request.seq, started: true });
  try {
    const lines = tokenize(
      hljs.highlight(request.code, {
        language: request.id,
        ignoreIllegals: true,
      }).value,
    );
    reply(lines ? { kind: 'lines', lines } : { kind: 'plain' });
  } catch {
    reply({ kind: 'plain' });
  }
}
