/**
 * `draft` with `text` added after it as its own paragraph. Never de-duplicated: a paragraph
 * that looks the same may be a message still sending, which a success then removes.
 */
export function appendDraft(draft: string, text: string): string {
  if (!text.trim()) return draft;
  return draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text;
}

/** `draft` with a `failed` message back in front of it, unless it already leads the draft. */
export function putBackDraft(draft: string, failed: string): string {
  return appendDraft(failed, withoutSent(draft, failed));
}

/**
 * `draft` without a `sent` message that was the whole draft when it was sent, so it leads the
 * draft; whatever was added after it stays. A draft that does not start with it is left alone.
 */
export function withoutSent(draft: string, sent: string): string {
  const head = sent.trim();
  const body = draft.trimStart();
  if (!head || !body.startsWith(head)) return draft;
  const rest = body.slice(head.length);
  if (!rest.trim()) return '';
  return /^\s*\n\s*\n/.test(rest) ? rest.trim() : draft;
}
