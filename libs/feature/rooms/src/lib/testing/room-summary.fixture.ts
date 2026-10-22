import type {
  PendingInvite,
  RoomSummary,
  SpaceSummary,
} from '@trinity/data-access/room-library';

/** A quiet, joined, non-DM room; a test passes every field its assertions read. */
export function roomSummary(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: '!a:hs',
    accountId: '@me:hs',
    accountIds: ['@me:hs'],
    name: 'general',
    initial: 'G',
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: 0,
    highlightCount: 0,
    hasUnread: false,
    markedUnread: false,
    lastMessage: '',
    lastMessageMark: null,
    activityTs: 0,
    favourite: false,
    lowPriority: false,
    ...over,
  };
}

/** An empty space owned by `@me:hs`. */
export function spaceSummary(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: '!s:hs',
    accountId: '@me:hs',
    name: 'Space',
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
    ...over,
  };
}

/** A pending room invite from Alice. */
export function pendingInvite(
  over: Partial<PendingInvite> = {},
): PendingInvite {
  return {
    roomId: '!i:hs',
    accountId: '@me:hs',
    name: 'Invited Room',
    initial: 'I',
    avatarMxc: null,
    inviterName: 'Alice',
    inviterId: '',
    isSpace: false,
    isDirect: false,
    ...over,
  };
}
