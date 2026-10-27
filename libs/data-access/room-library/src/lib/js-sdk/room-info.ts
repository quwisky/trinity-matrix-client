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
import { compareOrder } from '../space-child-order';
import { initialOf } from '../room-projection';
import { type RoomSummary } from '../room-library.service';

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
