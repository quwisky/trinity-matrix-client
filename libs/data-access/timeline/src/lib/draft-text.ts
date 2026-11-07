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
 * other text put back in front of it meanwhile stays. A draft that does not hold it is left alone.
 */
export function withoutSent(draft: string, sent: string): string {
  const wanted = sent
    .trim()
    .split(PARAGRAPHS)
    .map((part) => part.trim());
  if (!wanted[0]) return draft;
  const parts = draft.split(PARAGRAPHS);
  for (let at = 0; at + wanted.length <= parts.length; at += 1) {
    if (wanted.every((part, i) => parts[at + i]?.trim() === part)) {
      parts.splice(at, wanted.length);
      return parts.join('\n\n').trim();
    }
  }
  return draft;
}
