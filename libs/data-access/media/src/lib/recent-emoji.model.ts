/** MSC4356 recently used emoji, in account data. Spec v1.18. */
export const RECENT_EMOJI_EVENT_TYPE = 'm.recent_emoji';
/** MSC4356's unstable prefix; read only, as a seed. */
export const UNSTABLE_RECENT_EMOJI_EVENT_TYPE =
  'io.github.johennes.msc4356.recent_emoji';
/** Element's own `[emoji, count]` tuples; read only, as a seed. */
export const ELEMENT_RECENT_EMOJI_EVENT_TYPE = 'io.element.recent_emoji';

/** How many recent emoji the picker shows. */
export const RECENT_EMOJI_SHOWN = 24;
/** How many entries the account data keeps. */
export const RECENT_EMOJI_KEPT = 100;

/** One MSC4356 entry. `emoji` is a Unicode emoji or, from other clients, an `mxc://` URI. */
export interface RecentEmojiEntry {
  readonly emoji: string;
  readonly total: number;
}

function isEntry(emoji: unknown, total: unknown): boolean {
  return (
    typeof emoji === 'string' &&
    emoji.length > 0 &&
    typeof total === 'number' &&
    Number.isInteger(total) &&
    total > 0
  );
}

function listIn(content: unknown): readonly unknown[] {
  const list =
    typeof content === 'object' && content !== null
      ? (content as { recent_emoji?: unknown }).recent_emoji
      : undefined;
  return Array.isArray(list) ? list : [];
}

/** The valid entries of MSC4356 content (stable or unstable type), newest first. */
export function parseRecentEmoji(content: unknown): RecentEmojiEntry[] {
  return listIn(content).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { emoji, total } = item as { emoji?: unknown; total?: unknown };
    return isEntry(emoji, total)
      ? [{ emoji: emoji as string, total: total as number }]
      : [];
  });
}

/** The valid entries of Element's `io.element.recent_emoji` tuples, newest first. */
export function parseElementRecentEmoji(content: unknown): RecentEmojiEntry[] {
  return listIn(content).flatMap((item) => {
    if (!Array.isArray(item)) return [];
    const [emoji, total] = item as unknown[];
    return isEntry(emoji, total)
      ? [{ emoji: emoji as string, total: total as number }]
      : [];
  });
}

/** Each pick, oldest first, moved to the front with its count increased; capped. */
export function applyPicks(
  entries: readonly RecentEmojiEntry[],
  picks: readonly string[],
): RecentEmojiEntry[] {
  let next = [...entries];
  for (const emoji of picks) {
    const previous = next.find((entry) => entry.emoji === emoji);
    next = [
      { emoji, total: (previous?.total ?? 0) + 1 },
      ...next.filter((entry) => entry.emoji !== emoji),
    ];
  }
  return next.slice(0, RECENT_EMOJI_KEPT);
}

/** A pictograph, a flag letter or a keycap; other text and `mxc://` custom emoji are not shown. */
const SHOWABLE_EMOJI =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/**
 * The most recent Unicode emoji, then stably sorted by count as MSC4356's example does, so
 * equal counts keep their recency.
 */
export function shownRecentEmoji(
  entries: readonly RecentEmojiEntry[],
): string[] {
  return entries
    .filter(
      (entry) =>
        !entry.emoji.startsWith('mxc://') && SHOWABLE_EMOJI.test(entry.emoji),
    )
    .slice(0, RECENT_EMOJI_SHOWN)
    .sort((left, right) => right.total - left.total)
    .map((entry) => entry.emoji);
}

export function recentEmojiContent(entries: readonly RecentEmojiEntry[]): {
  recent_emoji: RecentEmojiEntry[];
} {
  return {
    recent_emoji: entries.map(({ emoji, total }) => ({ emoji, total })),
  };
}
