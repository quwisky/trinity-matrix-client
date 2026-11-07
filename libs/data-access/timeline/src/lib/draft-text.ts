const PARAGRAPHS = /\n\s*\n/;

/**
 * `draft` with `text` added after it as its own paragraph. Never de-duplicated: a paragraph
 * that looks the same may be a message still sending, which a success then removes.
 */
export function appendDraft(draft: string, text: string): string {
  if (!text.trim()) return draft;
  return draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text;
}

/** `draft` with a `failed` message moved, or put, in front of it. */
export function putBackDraft(draft: string, failed: string): string {
  return appendDraft(failed, withoutSent(draft, failed));
}

/**
 * `draft` without the first run of paragraphs that is exactly a `sent` message, wherever it sits:
 * other text put back in front of it meanwhile stays. Byte-preserving: only the run and one
 * separator next to it go, so code blocks and indentation elsewhere are untouched. A draft that
 * does not hold it is left alone.
 */
export function withoutSent(draft: string, sent: string): string {
  const wanted = sent
    .trim()
    .split(PARAGRAPHS)
    .map((part) => part.trim());
  if (!wanted[0]) return draft;
  // Paragraphs at even indexes, the separators between them at odd ones.
  const parts = draft.split(/(\n\s*\n)/);
  const span = 2 * wanted.length - 1;
  for (let at = 0; at + span <= parts.length; at += 2) {
    if (!wanted.every((part, i) => parts[at + 2 * i]?.trim() === part)) {
      continue;
    }
    if (at + span < parts.length) parts.splice(at, span + 1);
    else if (at > 0) parts.splice(at - 1, span + 1);
    else parts.splice(at, span);
    return parts.join('');
  }
  return draft;
}
