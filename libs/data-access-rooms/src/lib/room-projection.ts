import {
  EventType,
  NotificationCountType,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { liveRoomState, messagePreview } from '@trinity/util-matrix';
import { type RoomSummary } from './rooms.service';

/** State event type linking a space to a child room. */
const SPACE_CHILD_EVENT = 'm.space.child';

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
  return {
    id: room.roomId,
    accountId,
    accountIds: [accountId],
    name,
    initial: initialOf(name),
    avatarMxc: room.getMxcAvatarUrl(),
    topic: (topicEvent?.getContent()?.['topic'] as string) ?? '',
    memberCount: room.getJoinedMemberCount(),
    encrypted: room.hasEncryptionStateEvent(),
    unreadCount,
    highlightCount,
    hasUnread: unreadCount > 0,
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
