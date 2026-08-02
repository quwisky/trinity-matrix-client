import {
  EventType,
  NotificationCountType,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import {
  liveRoomState,
  messagePreview,
  roomAvatarMxc,
} from '@trinity/util-matrix';
import { type RoomSummary } from './rooms.service';

/** State event type linking a space to a child room. */
const SPACE_CHILD_EVENT = 'm.space.child';

/**
 * The unstable prefix some clients still write for MSC2867's marked-unread flag. Read as
 * well as the stable `m.marked_unread` so a room flagged in an older client shows here;
 * only the stable one is ever written.
 */
const LEGACY_MARKED_UNREAD = 'com.famedly.marked_unread';

/** Both marked-unread event types, hoisted so the projection does not rebuild it per room. */
const MARKED_UNREAD_TYPES = [
  EventType.MarkedUnread,
  LEGACY_MARKED_UNREAD,
] as const;

/**
 * Whether the user has explicitly flagged this room to come back to (MSC2867).
 *
 * Purely a client-side marker held in room account data: the read receipt does not move,
 * so the server's notification counts stay at zero and this is the only thing that says
 * the room wants attention. Absent, or `{unread: false}`, both mean not flagged — Element
 * writes the latter to clear it rather than redacting the event.
 */
export function isMarkedUnread(room: Room): boolean {
  for (const type of MARKED_UNREAD_TYPES) {
    const content = room.getAccountData?.(type)?.getContent();
    if (content?.['unread'] === true) {
      return true;
    }
  }
  return false;
}

/** Internal scratch shape used while sorting a space's children. */
interface ChildEntry {
  id: string;
  order: string;
  name: string;
}

/** First visible character (sans leading `#`/`@`), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}

/**
 * Single-line preview of the room's most recent `m.room.message`, or `''` when the
 * room has no message in its live timeline. Walked back-to-front so state events between
 * messages are skipped. `getLiveTimeline` is called optionally — not every Room stub
 * (unit fakes) exposes it.
 */
export function lastMessageOf(room: Room): string {
  const events = room.getLiveTimeline?.()?.getEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].getType() === EventType.RoomMessage) {
      return messagePreview(events[i]);
    }
  }
  return '';
}

/**
 * The account's `m.direct` map reversed into the set of DM room ids and a roomId →
 * counterpart-user-id lookup, so each DM row can carry the other party. `getAccountData`
 * is optional so a stub client without account data yields empty rather than throwing.
 */
export function directMapOf(client: MatrixClient): {
  ids: Set<string>;
  userByRoom: Map<string, string>;
} {
  const ids = new Set<string>();
  const userByRoom = new Map<string, string>();
  const map =
    client
      .getAccountData?.(EventType.Direct)
      ?.getContent<Record<string, string[]>>() ?? {};
  for (const [userId, roomIds] of Object.entries(map)) {
    if (Array.isArray(roomIds)) {
      for (const roomId of roomIds) {
        ids.add(roomId);
        if (!userByRoom.has(roomId)) {
          userByRoom.set(roomId, userId);
        }
      }
    }
  }
  return { ids, userByRoom };
}

/**
 * Project one {@link Room} into a {@link RoomSummary}, tagged with the account it belongs
 * to. Pure read of the room — shared by {@link RoomsService} (single active account) and
 * the cross-account {@link MixedRoomsService} so both build identical rows.
 */
export function buildRoomSummary(
  room: Room,
  accountId: string,
  directUserId?: string,
): RoomSummary {
  const name = room.name || room.roomId;
  const topicEvent = liveRoomState(room)?.getStateEvents('m.room.topic', '');
  const unreadCount = room.getUnreadNotificationCount(
    NotificationCountType.Total,
  );
  const highlightCount = room.getUnreadNotificationCount(
    NotificationCountType.Highlight,
  );
  const markedUnread = isMarkedUnread(room);
  return {
    id: room.roomId,
    accountId,
    accountIds: [accountId],
    name,
    initial: initialOf(name),
    // `m.direct` is the authoritative answer to "is this a DM", and it is already in
    // hand — the SDK's own member-count heuristic would also claim a two-person named
    // group room, and dress it in that member's face until a third person joined.
    avatarMxc: roomAvatarMxc(room, directUserId !== undefined),
    topic: (topicEvent?.getContent()?.['topic'] as string) ?? '',
    memberCount: room.getJoinedMemberCount(),
    encrypted: room.hasEncryptionStateEvent(),
    unreadCount,
    highlightCount,
    markedUnread,
    // A flagged room reads as unread even with nothing new in it — that is the whole
    // point of flagging it — so the badge and the sidebar's unread filter both follow.
    hasUnread: unreadCount > 0 || markedUnread,
    lastMessage: lastMessageOf(room),
    activityTs: room.getLastActiveTimestamp(),
    favourite: room.tags?.['m.favourite'] !== undefined,
    directUserId,
  };
}

/** Favourite-first, then most recently active, then name — the room list ordering. */
export function compareRoomSummaries(a: RoomSummary, b: RoomSummary): number {
  return (
    Number(b.favourite) - Number(a.favourite) ||
    b.activityTs - a.activityTs ||
    a.name.localeCompare(b.name)
  );
}

/**
 * A space's *joined* child room ids, ordered by the `m.space.child` `order` field
 * (lexicographic) then room name. Children we have not joined — and removed/dangling
 * child links — are dropped. Pure read of the space room, shared by {@link SpacesService}
 * (active account) and the cross-account {@link MixedSpacesService}.
 */
export function spaceChildIdsOf(client: MatrixClient, space: Room): string[] {
  const children = (
    liveRoomState(space)?.getStateEvents(SPACE_CHILD_EVENT) ?? []
  )
    .map((event): ChildEntry | null => {
      const childId = event.getStateKey();
      const content = event.getContent();
      const via = content['via'];
      if (!childId || !Array.isArray(via) || via.length === 0) {
        return null; // removed / invalid child link
      }
      const child = client.getRoom(childId);
      if (!child || child.getMyMembership() !== 'join') {
        return null; // only joined children
      }
      const order =
        typeof content['order'] === 'string' ? content['order'] : '';
      return { id: childId, order, name: child.name || childId };
    })
    .filter((entry): entry is ChildEntry => entry !== null);

  children.sort(
    (a, b) => a.order.localeCompare(b.order) || a.name.localeCompare(b.name),
  );
  return children.map((entry) => entry.id);
}

/**
 * The orderings a space's room list can be shown in, as `{ id, label, description }` for the
 * UI. The descriptions are not decoration: "Space order" is meaningless without being told
 * whose order it is, and both surfaces let you pick an ordering without seeing its effect.
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
 * Favourite-first, shared by every ordering.
 *
 * The sidebar renders favourites as their own group, so this term does not change what is on
 * screen. It is not a no-op for the array itself, which is what the keyboard walk and "mark
 * all read" iterate — without it those would walk a different order from the one rendered.
 */
function favouriteFirst(a: RoomSummary, b: RoomSummary): number {
  return Number(b.favourite) - Number(a.favourite);
}

/**
 * Position lookup for {@link comparatorFor}'s `'space'` mode: room id → index in the space's
 * curated child order.
 *
 * Built from the id list the rows were mapped from, because a child's `m.space.child` `order`
 * belongs to the *space*, not to a {@link RoomSummary} — there is nothing on the row itself to
 * sort by. First occurrence wins, so the result is well defined for any input, though neither
 * producer emits a repeat today (`spaceChildIdsOf` reads one state event per child, and
 * `MixedSpacesService` dedupes as it concatenates).
 *
 * **Mixed accounts see an approximation.** `MixedSpacesService` builds its child list by
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
 * The comparator for one ordering. A factory rather than `compare(a, b, mode)` so the mode
 * switch is resolved — and the rank map built — once per sort, not once per comparison.
 *
 * `childIds` is the space's curated order, read only by `'space'`; the other modes never walk
 * it, which is why the rank map is built inside that branch rather than by the caller (this
 * runs on every sync, and the shipped default is `'recent'`). An id the list does not hold
 * sorts last rather than yielding `NaN`, which would make `sort` implementation-defined.
 *
 * NOTE: `Array.prototype.sort` mutates, and `RoomsService.rooms()` / `MixedRoomsService.rooms()`
 * hand out their array by identity — sort a copy you own, never the signal's value.
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
        (rank.get(a.id) ?? UNRANKED) - (rank.get(b.id) ?? UNRANKED) ||
        a.name.localeCompare(b.name);
    }
    case 'alphabetical':
      return (a, b) => favouriteFirst(a, b) || a.name.localeCompare(b.name);
    case 'recent':
    default:
      // The app-wide comparator itself, so a space in this mode reads exactly like the
      // Recent view filtered down to that space.
      return compareRoomSummaries;
  }
}
