import { holdsText } from '@trinity/platform-native';

const PARAGRAPHS = /\n\s*\n/;

/** `draft` with each paragraph of `more` it does not already hold added after it. */
export function mergeDrafts(draft: string, more: string): string {
  let merged = draft;
  for (const part of more.split(PARAGRAPHS)) {
    if (!part.trim() || holdsText(merged, part)) continue;
    merged = merged.trim()
      ? `${merged.trimEnd()}\n\n${part.trim()}`
      : part.trim();
  }
  return merged;
}

/** `draft` without the paragraphs of a `sent` message, so text kept beside it stays. */
export function withoutSent(draft: string, sent: string): string {
  const left = draft.split(PARAGRAPHS);
  for (const part of sent.split(PARAGRAPHS)) {
    const at = left.findIndex((kept) => kept.trim() === part.trim());
    if (at >= 0) left.splice(at, 1);
  }
  return left.join('\n\n').trim();
}
