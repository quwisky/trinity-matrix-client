import {
  EventType,
  NotificationCountType,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import {
  arrivedInClear,
  liveRoomState,
  messagePreview,
  roomAvatarMxc,
  unencryptedMarkFor,
  type RoomEncryptionFlags,
  type UnencryptedMark,
} from '@trinity/util/matrix';
import { compareOrder } from './space-child-order';
import { type RoomSummary } from './room-library.service';

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

interface ChildEntry {
  id: string;
  order: string;
  name: string;
}

/** First visible character (sans leading `#`/`@`/`!`), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}

/**
 * Single-line preview of the room's most recent `m.room.message`, or `''`, and its
 * not-encrypted mark. Walked back-to-front to skip state events. `getLiveTimeline` is
 * optional: not every Room stub exposes it. `encrypted` is `undefined` while the crypto store
 * has yet to answer for the room.
 */
function lastMessageOf(
  room: Room,
  encrypted: boolean | undefined,
): { text: string; mark: UnencryptedMark | null } {
  const events = room.getLiveTimeline?.()?.getEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].getType() === EventType.RoomMessage) {
      // Until the store answers, the room may be encrypted without its state saying so.
      if (encrypted === undefined && arrivedInClear(events[i])) {
        return { text: '', mark: null };
      }
      return {
        text: messagePreview(events[i]),
        mark: unencryptedMarkFor(room, encrypted === true)(events[i]),
      };
    }
  }
  return { text: '', mark: null };
}

/**
 * When the room was last active, for recency ordering: the newest of its main timeline's last
 * event and each thread's latest reply (its root, for a thread with no reply yet).
 *
 * The client runs with `threadSupport`, so a thread reply lives in its thread's timeline and
 * `getLastActiveTimestamp()` alone never sees it. As in Element Web, any thread's latest reply
 * counts, read or not; unlike Element, the main-timeline part stays as the SDK reports it, so
 * reactions and profile changes still move a room. `getThreads` is optional for Room stubs.
 *
 * Only threads the client has loaded count: one whose replies fell outside the initial sync
 * window moves the room once it is fetched (the threads panel) or gets a new reply.
 */
export function roomActivityTs(room: Room): number {
  let latest = room.getLastActiveTimestamp();
  for (const thread of room.getThreads?.() ?? []) {
    const ts = (thread.replyToEvent ?? thread.rootEvent)?.getTs();
    if (ts !== undefined && ts > latest) {
      latest = ts;
    }
  }
  return latest;
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
 * Project one {@link Room} into a {@link RoomSummary} tagged with its account. Pure read, shared
 * by {@link RoomLibraryService} (active account) and the selected-Account projector so both
 * build identical rows. Without a crypto store (`hasCryptoStore` false) nothing will answer
 * for the room, so its preview counts it as encrypted.
 */
export function buildRoomSummary(
  room: Room,
  accountId: string,
  directUserId?: string,
  encryption?: RoomEncryptionFlags,
  hasCryptoStore = true,
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
  const encrypted =
    encryption?.isEncrypted(room) ?? room.hasEncryptionStateEvent();
  const previewEncrypted = !hasCryptoStore
    ? true
    : room.hasEncryptionStateEvent() || encryption?.answered(room.roomId)
      ? encrypted
      : undefined;
  const lastMessage = lastMessageOf(room, previewEncrypted);
  return {
    id: room.roomId,
    accountId,
    accountIds: [accountId],
    name,
    initial: initialOf(name),
    // `m.direct` is the authoritative answer to "is this a DM", and it is already in hand: the
    // SDK's own member-count heuristic would also claim a two-person named group room and dress
    // it in that member's face until a third person joined.
    avatarMxc: roomAvatarMxc(room, directUserId !== undefined),
    topic: (topicEvent?.getContent()?.['topic'] as string) ?? '',
    memberCount: room.getJoinedMemberCount(),
    encrypted,
    unreadCount,
    highlightCount,
    markedUnread,
    // A flagged room reads as unread even with nothing new in it, so the badge and the
    // sidebar's unread filter both follow.
    hasUnread: unreadCount > 0 || markedUnread,
    lastMessage: lastMessage.text,
    lastMessageMark: lastMessage.mark,
    activityTs: roomActivityTs(room),
    favourite: room.tags?.['m.favourite'] !== undefined,
    lowPriority: room.tags?.['m.lowpriority'] !== undefined,
    directUserId,
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
 * A Space this Account holds: it has joined it. A Space it left, or was removed from, stays
 * in the SDK store with that membership, and an accepted invitation keeps `invite` until the
 * join syncs; neither counts.
 */
export function isJoinedSpace(room: Room): boolean {
  return room.isSpaceRoom() && room.getMyMembership() === 'join';
}

/**
 * A space's *joined* child room ids, ordered by the `m.space.child` `order` field
 * (Unicode code point, unordered children last) then room name. Children we have not
 * joined — and removed/dangling child links — are dropped. Pure read of the space room,
 * shared by {@link SpacesService} (active account) and the selected-Account projector.
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
    (a, b) => compareOrder(a.order, b.order) || a.name.localeCompare(b.name),
  );
  return children.map((entry) => entry.id);
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
