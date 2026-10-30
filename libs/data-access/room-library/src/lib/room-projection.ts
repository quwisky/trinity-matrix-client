import { type RoomSummary } from './room-library.service';
import type { RoomInfo } from './room-list-engine';

/** First visible character (sans leading `#`/`@`/`!`), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}

/** One room's engine data as the sidebar row of `accountId`. */
export function roomSummaryOf(accountId: string, info: RoomInfo): RoomSummary {
  return {
    id: info.roomId,
    accountId,
    accountIds: [accountId],
    name: info.displayName,
    initial: initialOf(info.displayName),
    avatarMxc: info.avatarMxc,
    topic: info.topic,
    memberCount: info.joinedMemberCount,
    encrypted: info.encryption === 'encrypted',
    unreadCount: info.notificationCount,
    highlightCount: info.highlightCount,
    markedUnread: info.markedUnread,
    // A flagged room reads as unread even with nothing new in it, so the badge and the
    // sidebar's unread filter both follow.
    hasUnread: info.notificationCount > 0 || info.markedUnread,
    lastMessage: info.latestMessage?.text ?? '',
    lastMessageMark: info.latestMessage?.mark ?? null,
    activityTs: info.recencyStamp,
    favourite: info.favourite,
    lowPriority: info.lowPriority,
    ...(info.directUserId === null ? {} : { directUserId: info.directUserId }),
  };
}

/**
 * Favourite-first, low-priority-last, then most recently active, then name: the room list
 * ordering.
 *
 * A room tagged BOTH `m.favourite` and `m.lowpriority` sorts as a favourite. Matrix permits both
 * and says nothing about precedence, so this is a choice: a starred room should not sink out of
 * sight because it was demoted at some point.
 */
export function compareRoomSummaries(a: RoomSummary, b: RoomSummary): number {
  return (
    favouriteFirst(a, b) ||
    lowPriorityLast(a, b) ||
    b.activityTs - a.activityTs ||
    a.name.localeCompare(b.name)
  );
}

/**
 * The orderings a space's room list can be shown in, as `{ id, label, description }` for the UI.
 * The descriptions are needed: "Space order" is meaningless without saying whose order it is,
 * and both surfaces let you pick an ordering without seeing its effect.
 */
export const TRINITY_ROOM_SORTS = [
  {
    id: 'recent',
    label: 'Recent activity',
    description: 'Most recently active first, like every other list.',
  },
  {
    id: 'space',
    label: 'Space order',
    description: 'The order the space itself arranges its rooms in.',
  },
  {
    id: 'alphabetical',
    label: 'Alphabetical',
    description: 'By room name, A to Z.',
  },
] as const;

/** One of the orderings above. */
export type RoomSortMode = (typeof TRINITY_ROOM_SORTS)[number]['id'];

/** Recent activity — the order every other room list in the app already uses. */
export const DEFAULT_ROOM_SORT: RoomSortMode = 'recent';

/**
 * Whether a stored or bound string is one of the orderings we ship.
 *
 * `undefined` is in the parameter type deliberately: `hlm-select`'s `valueChange` is
 * `string | null | undefined`, and guarding a massaged expression (`isRoomSortMode(v ?? null)`)
 * narrows only that expression, leaving the original binding wide. That type-checks under
 * Vitest and fails only in the Angular build.
 */
export function isRoomSortMode(
  value: string | null | undefined,
): value is RoomSortMode {
  return TRINITY_ROOM_SORTS.some((option) => option.id === value);
}

/** Sorts after every ranked room, so an id missing from the rank map lands last. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Favourite-first, shared by every ordering. The sidebar renders favourites as their own group,
 * but the array itself is what the keyboard walk and "mark all read" iterate; without this term
 * they would walk a different order from the one rendered.
 */
function favouriteFirst(a: RoomSummary, b: RoomSummary): number {
  return Number(b.favourite) - Number(a.favourite);
}

/**
 * Low-priority-last, shared by every ordering and applied AFTER {@link favouriteFirst} so a
 * room carrying both tags stays with the favourites. It exists for the same reason as
 * favouriteFirst: the iterated array must match the rendered order.
 */
function lowPriorityLast(a: RoomSummary, b: RoomSummary): number {
  return Number(a.lowPriority) - Number(b.lowPriority);
}

/**
 * Position lookup for {@link comparatorFor}'s `'space'` mode: room id → index in the space's
 * curated child order.
 *
 * Built from the id list the rows were mapped from, because a child's `m.space.child` `order`
 * belongs to the *space*, not to a {@link RoomSummary}. First occurrence wins, so any input is
 * well defined.
 *
 * **Selected Accounts see an approximation.** The selected projector builds its child list by
 * concatenating each account's children in sorted-user-id order rather than merge-sorting by
 * the `order` string, so a space spanning two accounts ranks the first account's curated
 * children ahead of the second's extras. This reproduces that list verbatim; fixing it means
 * fixing the projection.
 */
export function spaceRankOf(
  childIds: readonly string[],
): ReadonlyMap<string, number> {
  const rank = new Map<string, number>();
  for (let i = 0; i < childIds.length; i++) {
    if (!rank.has(childIds[i])) {
      rank.set(childIds[i], i);
    }
  }
  return rank;
}

/**
 * The comparator for one ordering. A factory so the mode switch is resolved, and the rank map
 * built, once per sort rather than once per comparison.
 *
 * `childIds` is the space's curated order, read only by `'space'`; the rank map is built inside
 * that branch because this runs on every sync and the default is `'recent'`. An id the list does
 * not hold sorts last rather than yielding `NaN`, which would make `sort` implementation-defined.
 *
 * NOTE: `Array.prototype.sort` mutates, and Room Library projections hand out their array by
 * identity — sort a copy you own, never the signal's value.
 */
export function comparatorFor(
  mode: RoomSortMode,
  childIds: readonly string[] = [],
): (a: RoomSummary, b: RoomSummary) => number {
  switch (mode) {
    case 'space': {
      const rank = spaceRankOf(childIds);
      return (a, b) =>
        favouriteFirst(a, b) ||
        lowPriorityLast(a, b) ||
        (rank.get(a.id) ?? UNRANKED) - (rank.get(b.id) ?? UNRANKED) ||
        a.name.localeCompare(b.name);
    }
    case 'alphabetical':
      return (a, b) =>
        favouriteFirst(a, b) ||
        lowPriorityLast(a, b) ||
        a.name.localeCompare(b.name);
    case 'recent':
    default:
      // The app-wide comparator itself, so a space in this mode reads exactly like the
      // Recent view filtered down to that space.
      return compareRoomSummaries;
  }
}
