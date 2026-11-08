/** `draft` with `text` added after it as its own paragraph. */
export function appendDraft(draft: string, text: string): string {
  if (!text.trim()) return draft;
  return draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text;
}
