import {
  EventType,
  MatrixError,
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
} from '@trinity/util/matrix';
import type { RoomInfo, RoomMembership } from '../room-list-engine';

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

/**
 * Single-line preview of the room's most recent `m.room.message` and its not-encrypted mark,
 * or null when the timeline holds none. Walked back-to-front to skip state events.
 * `getLiveTimeline` is optional: not every Room stub exposes it. `encrypted` is `undefined`
 * while the crypto store has yet to answer for the room.
 */
function lastMessageOf(
  room: Room,
  encrypted: boolean | undefined,
): RoomInfo['latestMessage'] {
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
  return null;
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

interface RoomInfoContext {
  readonly ownUserId: string | null;
  readonly directUserId: string | null;
  readonly encryption: RoomEncryptionFlags | undefined;
  /** Without a crypto store nothing will answer for the room, so its preview counts it as encrypted. */
  readonly hasCryptoStore: boolean;
}

function roomInfoOf(room: Room, context: RoomInfoContext): RoomInfo {
  const { directUserId, encryption, hasCryptoStore } = context;
  const membership = room.getMyMembership() as RoomMembership;
  const topic = liveRoomState(room)
    ?.getStateEvents('m.room.topic', '')
    ?.getContent()?.['topic'];
  const stateEncrypted = room.hasEncryptionStateEvent();
  const encrypted = encryption?.isEncrypted(room) ?? stateEncrypted;
  const answered = stateEncrypted || !!encryption?.answered(room.roomId);
  const previewEncrypted = !hasCryptoStore
    ? true
    : answered
      ? encrypted
      : undefined;
  const inviter = membership === 'invite' ? inviterOf(room, context) : null;
  return {
    roomId: room.roomId,
    membership,
    isSpace: room.isSpaceRoom(),
    displayName: room.name || room.roomId,
    // `m.direct` is the authoritative answer to "is this a DM", and it is already in hand: the
    // SDK's own member-count heuristic would also claim a two-person named group room and dress
    // it in that member's face until a third person joined. An invite's stripped state holds
    // only two members whatever the room size, so there `is_direct` decides.
    avatarMxc: roomAvatarMxc(
      room,
      inviter ? inviter.isDirect : directUserId !== null,
    ),
    topic: typeof topic === 'string' ? topic : '',
    joinedMemberCount: room.getJoinedMemberCount(),
    directUserId,
    // The old boolean is `encryption === 'encrypted'`. `unknown`: no state event and no
    // crypto-store answer yet, or no store to ask; the preview above already allows for it.
    encryption: encrypted
      ? 'encrypted'
      : answered && hasCryptoStore
        ? 'unencrypted'
        : 'unknown',
    historyVisibility: (room.getHistoryVisibility?.() ??
      'shared') as RoomInfo['historyVisibility'],
    notificationCount: room.getUnreadNotificationCount(
      NotificationCountType.Total,
    ),
    highlightCount: room.getUnreadNotificationCount(
      NotificationCountType.Highlight,
    ),
    markedUnread: isMarkedUnread(room),
    recencyStamp: roomActivityTs(room),
    latestMessage: lastMessageOf(room, previewEncrypted),
    favourite: room.tags?.['m.favourite'] !== undefined,
    lowPriority: room.tags?.['m.lowpriority'] !== undefined,
    inviter,
  };
}

/** Our own invite event names the inviter (its sender) and carries the inviter's `is_direct`. */
function inviterOf(
  room: Room,
  { ownUserId }: RoomInfoContext,
): RoomInfo['inviter'] {
  const invite = ownUserId ? room.getMember(ownUserId)?.events?.member : null;
  const userId = invite?.getSender();
  if (!invite || !userId) return null;
  return {
    userId,
    displayName: room.getMember(userId)?.name || userId,
    isDirect: invite.getContent()?.['is_direct'] === true,
  };
}

/** One {@link Room} as engine data. `directUserId` defaults to the reverse `m.direct` lookup. */
export function toRoomInfo(
  client: MatrixClient,
  room: Room,
  encryption: RoomEncryptionFlags,
  directUserId = directMapOf(client).userByRoom.get(room.roomId) ?? null,
): RoomInfo {
  return roomInfoOf(room, {
    ownUserId: client.getUserId?.() ?? null,
    directUserId,
    encryption,
    hasCryptoStore: !!client.getCrypto?.(),
  });
}

/**
 * A Space this Account holds: it has joined it. A Space it left, or was removed from, stays
 * in the SDK store with that membership, and an accepted invitation keeps `invite` until the
 * join syncs; neither counts.
 */
export function isJoinedSpace(room: Room): boolean {
  return room.isSpaceRoom() && room.getMyMembership() === 'join';
}

const INVITE_BLOCKED_ERRCODES = new Set([
  'M_INVITE_BLOCKED',
  'ORG.MATRIX.MSC4155.INVITE_BLOCKED',
]);

/** The invitee blocks invites (MSC4155), so the invite was refused. */
export function isInviteBlocked(error: unknown): boolean {
  return (
    error instanceof MatrixError &&
    INVITE_BLOCKED_ERRCODES.has(error.errcode ?? '')
  );
}
