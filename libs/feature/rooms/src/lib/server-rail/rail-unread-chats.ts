import { type AccountBadge } from '@trinity/components/generic-content';
import {
  RAIL_UNREAD_CHAT_LIMIT,
  type RailUnreadChatMode,
  type UnreadRoom,
} from '@trinity/data-access/room-library';
import { initialOf } from '@trinity/util/matrix';
import { type ExactRoomSelection } from '../shared/exact-selection';
import { unreadBadgeLabel } from '../shared/unread-badge';

/** One unread chat drawn in the space rail. */
export interface RailUnreadChat {
  /** Stable identity of the exact account-owned room. */
  readonly key: string;
  /** Account and room carried into the click. */
  readonly selection: ExactRoomSelection;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
  readonly direct: boolean;
  /** Badge text, capped at "99+"; null when the chat is only marked unread. */
  readonly countLabel: string | null;
  /** The owning account, when the rail must tell accounts apart. */
  readonly accountBadge: AccountBadge | null;
  /** Accessible name: the chat, its unread state and, when badged, the account. */
  readonly label: string;
}

/** The rail's unread chats and how many more are not listed. */
export interface RailUnreadChats {
  readonly entries: readonly RailUnreadChat[];
  /** Chats beyond the "Up to 5" cap, shown as the "+N" entry. */
  readonly overflow: number;
}

/** Shared empty result, so an empty rail keeps one stable reference. */
export const NO_RAIL_UNREAD_CHATS: RailUnreadChats = Object.freeze({
  entries: [],
  overflow: 0,
});

export interface RailUnreadChatsInput {
  readonly rooms: readonly UnreadRoom[];
  readonly mode: RailUnreadChatMode;
  /** The open chat, which is never listed. */
  readonly open: ExactRoomSelection | null;
  readonly activeAccountId: string | null;
  /** Several accounts are selected, so every entry names its account. */
  readonly mixed: boolean;
  readonly badges: ReadonlyMap<string, AccountBadge>;
}

/**
 * The space rail's unread chats: the open chat removed, newest first, capped for "Up to
 * 5" with the rest counted for the "+N" entry, each badged by the account rule.
 */
export function buildRailUnreadChats(
  input: RailUnreadChatsInput,
): RailUnreadChats {
  if (input.mode === 'off') return NO_RAIL_UNREAD_CHATS;
  // filter() returns a new array, so sorting never touches the input signal value.
  const candidates = input.rooms
    .filter((room) => !isOpen(room, input.open))
    .sort(newestFirst);
  const shown =
    input.mode === 'all'
      ? candidates
      : candidates.slice(0, RAIL_UNREAD_CHAT_LIMIT);
  if (shown.length === 0) return NO_RAIL_UNREAD_CHATS;
  return {
    entries: shown.map((room) => entryFor(room, input)),
    overflow: candidates.length - shown.length,
  };
}

function isOpen(room: UnreadRoom, open: ExactRoomSelection | null): boolean {
  return (
    !!open && open.accountId === room.accountId && open.roomId === room.roomId
  );
}

function newestFirst(a: UnreadRoom, b: UnreadRoom): number {
  return (
    b.activityTs - a.activityTs ||
    a.accountId.localeCompare(b.accountId) ||
    a.roomId.localeCompare(b.roomId)
  );
}

function entryFor(
  room: UnreadRoom,
  input: RailUnreadChatsInput,
): RailUnreadChat {
  const badged = input.mixed || room.accountId !== input.activeAccountId;
  const accountBadge = badged
    ? (input.badges.get(room.accountId) ?? fallbackBadge(room.accountId))
    : null;
  const state =
    room.unreadCount > 0 ? `${room.unreadCount} unread` : 'marked unread';
  return {
    key: `${room.accountId}\u0000${room.roomId}`,
    selection: { accountId: room.accountId, roomId: room.roomId },
    name: room.name,
    initial: room.initial,
    avatarMxc: room.avatarMxc,
    direct: room.direct,
    countLabel:
      room.unreadCount > 0 ? unreadBadgeLabel(room.unreadCount) : null,
    accountBadge,
    label: [
      room.name,
      state,
      ...(accountBadge ? [accountBadge.name] : []),
    ].join(' · '),
  };
}

function fallbackBadge(accountId: string): AccountBadge {
  return {
    id: accountId,
    name: accountId,
    initial: initialOf(accountId),
    avatarMxc: null,
  };
}
