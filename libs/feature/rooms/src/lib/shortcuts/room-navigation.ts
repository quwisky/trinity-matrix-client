import { type RoomSummary } from '@trinity/data-access/rooms';

/** Which way a walk-the-list shortcut moves. */
export type WalkDirection = 'next' | 'previous';

const STEP: Record<WalkDirection, number> = { next: 1, previous: -1 };

/**
 * The id one step from `activeId` in display order, wrapping at the ends. With no active
 * room, `next` starts at the top and `previous` at the bottom. Returns null only when the
 * list is empty. Drives Alt+↑/↓ walking the sidebar list.
 */
export function stepList(
  ids: readonly string[],
  activeId: string | null,
  direction: WalkDirection,
): string | null {
  if (ids.length === 0) {
    return null;
  }
  const current = activeId ? ids.indexOf(activeId) : -1;
  if (current === -1) {
    return direction === 'next' ? ids[0] : ids[ids.length - 1];
  }
  const next = (current + STEP[direction] + ids.length) % ids.length;
  return ids[next];
}

/**
 * The next/previous room with unread messages, in display order, wrapping past the
 * active room. With no active room, starts from the appropriate end. Returns null when
 * nothing is unread. Drives Alt+Shift+↑/↓ (jump to prev/next unread).
 */
export function stepUnread(
  rooms: readonly RoomSummary[],
  activeId: string | null,
  direction: WalkDirection,
): string | null {
  const unread = rooms.filter((room) => room.hasUnread);
  if (unread.length === 0) {
    return null;
  }
  const ids = unread.map((room) => room.id);
  // If the active room is itself unread, step relative to its slot; otherwise fall back
  // to the list ends so a walk from a read room lands on the first/last unread.
  if (activeId && ids.includes(activeId)) {
    return stepList(ids, activeId, direction);
  }
  return direction === 'next' ? ids[0] : ids[ids.length - 1];
}
