import { PREVIEW_LIMIT } from '../notification-policy';
import type { NotificationTextMode } from '../notification-text.port';

export type InboxTab = 'mentions' | 'all';

export type InboxPreview =
  | { readonly kind: 'text'; readonly text: string }
  /** Shown as `GENERIC_BODY`. */
  | { readonly kind: 'hidden' }
  /** Shown as "Encrypted message". */
  | { readonly kind: 'encrypted' }
  /** Shown as "Preview unavailable". */
  | { readonly kind: 'unavailable' };

export interface InboxRow {
  readonly accountId: string;
  readonly eventId: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly senderName: string | null;
  readonly ts: number;
  readonly preview: InboxPreview;
  readonly unread: boolean;
  /** Null also when the event is the thread's root. */
  readonly threadRootId: string | null;
}

/** The tab that asked: a result's wording is for that tab only. */
export type InboxLoadResult = { readonly tab: InboxTab } & (
  | { readonly kind: 'found' }
  | { readonly kind: 'end' }
  /** `checked` counts server rows. */
  | { readonly kind: 'limit'; readonly checked: number }
);

/** Newest first, ordered as the index orders them. The first list holding an event wins. */
export function mergeInboxRows(
  ...lists: readonly (readonly InboxRow[])[]
): readonly InboxRow[] {
  const byId = new Map<string, InboxRow>();
  for (const row of lists.flat()) {
    if (!byId.has(row.eventId)) byId.set(row.eventId, row);
  }
  return [...byId.values()].sort(
    (a, b) => b.ts - a.ts || (a.eventId < b.eventId ? 1 : -1),
  );
}

/** Follows the notification policy, except that this isn't a lock screen. */
export function inboxPreview(
  mode: NotificationTextMode,
  body: string | null,
): InboxPreview {
  const text = mode === 'always-hide' ? '' : (body?.trim() ?? '');
  return text
    ? { kind: 'text', text: text.slice(0, PREVIEW_LIMIT) }
    : { kind: 'hidden' };
}
