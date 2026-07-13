import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { initialOf, type MessageView } from './message-view';

/**
 * Framework-free projection of room *state* and *membership* events into the compact
 * "system" lines shown between messages (e.g. `Alice changed the room name to "General"`,
 * `Bob joined the room`). Kept out of {@link MessageView}'s message path so the two stay
 * cleanly separated; the timeline interleaves both in chronological order.
 */

/** State / membership event types rendered as a system line. */
const DISPLAYABLE_STATE_TYPES = new Set<string>([
  EventType.RoomMember,
  EventType.RoomName,
  EventType.RoomTopic,
  EventType.RoomAvatar,
  EventType.RoomCanonicalAlias,
  EventType.RoomJoinRules,
  EventType.RoomHistoryVisibility,
  EventType.RoomGuestAccess,
  EventType.RoomEncryption,
  EventType.RoomCreate,
]);

/** Whether an event is a (non-redacted) state change we summarise as a system line. */
export function isDisplayableStateEvent(event: MatrixEvent): boolean {
  return (
    event.isState() &&
    !event.isRedacted() &&
    DISPLAYABLE_STATE_TYPES.has(event.getType())
  );
}

/** A non-empty string, else null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** The display name of the member who sent `event`, falling back to their id. */
function actorName(event: MatrixEvent, room: Room | undefined): string {
  const sender = event.getSender() ?? '';
  return room?.getMember(sender)?.name || sender || 'Someone';
}

/** A member's display name — the supplied one, else the room's, else the bare id. */
function nameFor(
  room: Room | undefined,
  userId: string,
  displayname?: string | null,
): string {
  return displayname || room?.getMember(userId)?.name || userId || 'Someone';
}

/**
 * A one-line, human-readable summary of a state / membership change, or null when there's
 * nothing worth showing (an unsupported type, or a no-op membership event such as a repeat
 * `join` that changed neither display name nor avatar). Naming is resolved through `room`.
 */
export function describeTimelineEvent(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  switch (event.getType()) {
    case EventType.RoomMember:
      return describeMembership(event, room);
    case EventType.RoomName:
      return describeName(event, room);
    case EventType.RoomTopic:
      return describeTopic(event, room);
    case EventType.RoomAvatar:
      return describeAvatar(event, room);
    case EventType.RoomCanonicalAlias:
      return describeCanonicalAlias(event, room);
    case EventType.RoomJoinRules:
      return describeJoinRules(event, room);
    case EventType.RoomHistoryVisibility:
      return describeHistoryVisibility(event, room);
    case EventType.RoomGuestAccess:
      return describeGuestAccess(event, room);
    case EventType.RoomEncryption:
      return `${actorName(event, room)} turned on end-to-end encryption`;
    case EventType.RoomCreate:
      return `${actorName(event, room)} created the room`;
    default:
      return null;
  }
}

function describeMembership(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const content = event.getContent() as Record<string, unknown>;
  const prev = event.getPrevContent() as Record<string, unknown>;
  const membership = content['membership'];
  const was = prev['membership'];
  const target = event.getStateKey() ?? '';
  const actorIsTarget = event.getSender() === target;
  const actor = actorName(event, room);
  const targetName = nameFor(room, target, str(content['displayname']));
  const reason = str(content['reason']);
  const because = reason ? `: ${reason}` : '';

  switch (membership) {
    case 'join': {
      if (was !== 'join') {
        return `${targetName} joined the room`;
      }
      // Same membership → a profile change (or nothing visible).
      const prevName = str(prev['displayname']);
      const newName = str(content['displayname']);
      if (prevName !== newName) {
        return newName
          ? `${prevName || target} changed their display name to "${newName}"`
          : `${prevName || target} removed their display name`;
      }
      if (prev['avatar_url'] !== content['avatar_url']) {
        return `${targetName} changed their profile picture`;
      }
      return null;
    }
    case 'invite':
      return `${actor} invited ${targetName}`;
    case 'knock':
      return `${targetName} requested to join`;
    case 'ban':
      return `${actor} banned ${targetName}${because}`;
    case 'leave':
      if (was === 'ban') {
        return `${actor} unbanned ${targetName}`;
      }
      if (actorIsTarget) {
        if (was === 'invite') {
          return `${targetName} rejected the invitation`;
        }
        if (was === 'knock') {
          return `${targetName} cancelled their request to join`;
        }
        return `${targetName} left the room`;
      }
      return was === 'invite'
        ? `${actor} withdrew ${targetName}'s invitation`
        : `${actor} removed ${targetName}${because}`;
    default:
      return null;
  }
}

function describeName(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const name = str((event.getContent() as Record<string, unknown>)['name']);
  const had = str((event.getPrevContent() as Record<string, unknown>)['name']);
  if (name === had) {
    return null; // a re-assert that didn't actually change the name
  }
  const actor = actorName(event, room);
  if (!name) {
    return `${actor} removed the room name`;
  }
  return `${actor} ${had ? 'changed' : 'set'} the room name to "${name}"`;
}

function describeTopic(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const topic = str((event.getContent() as Record<string, unknown>)['topic']);
  const had = str((event.getPrevContent() as Record<string, unknown>)['topic']);
  if (topic === had) {
    return null;
  }
  const actor = actorName(event, room);
  if (!topic) {
    return `${actor} removed the room topic`;
  }
  return `${actor} ${had ? 'changed' : 'set'} the room topic`;
}

function describeAvatar(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const url = str((event.getContent() as Record<string, unknown>)['url']);
  const had = str((event.getPrevContent() as Record<string, unknown>)['url']);
  if (url === had) {
    return null;
  }
  const actor = actorName(event, room);
  return url
    ? `${actor} changed the room avatar`
    : `${actor} removed the room avatar`;
}

function describeCanonicalAlias(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const alias = str((event.getContent() as Record<string, unknown>)['alias']);
  const had = str((event.getPrevContent() as Record<string, unknown>)['alias']);
  if (alias === had) {
    return null;
  }
  const actor = actorName(event, room);
  return alias
    ? `${actor} set the main address to ${alias}`
    : `${actor} removed the main address`;
}

function describeJoinRules(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const rule = (event.getContent() as Record<string, unknown>)['join_rule'];
  if (
    rule === (event.getPrevContent() as Record<string, unknown>)['join_rule']
  ) {
    return null;
  }
  const actor = actorName(event, room);
  switch (rule) {
    case 'public':
      return `${actor} made the room public (anyone can join)`;
    case 'invite':
      return `${actor} made the room invite-only`;
    case 'knock':
      return `${actor} allowed people to request to join`;
    default:
      return `${actor} changed who can join the room`;
  }
}

const HISTORY_VISIBILITY: Readonly<Record<string, string>> = {
  world_readable: 'anyone, even without joining',
  shared: 'members, including history from before they joined',
  invited: 'members, from the point they were invited',
  joined: 'members, from the point they joined',
};

function describeHistoryVisibility(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const visibility = (event.getContent() as Record<string, unknown>)[
    'history_visibility'
  ];
  if (
    visibility ===
    (event.getPrevContent() as Record<string, unknown>)['history_visibility']
  ) {
    return null;
  }
  const actor = actorName(event, room);
  const audience =
    typeof visibility === 'string' ? HISTORY_VISIBILITY[visibility] : undefined;
  return audience
    ? `${actor} made future room history visible to ${audience}`
    : `${actor} changed who can read history`;
}

function describeGuestAccess(
  event: MatrixEvent,
  room: Room | undefined,
): string | null {
  const access = (event.getContent() as Record<string, unknown>)[
    'guest_access'
  ];
  if (
    access ===
    (event.getPrevContent() as Record<string, unknown>)['guest_access']
  ) {
    return null;
  }
  const actor = actorName(event, room);
  switch (access) {
    case 'can_join':
      return `${actor} allowed guests to join`;
    case 'forbidden':
      return `${actor} stopped guests from joining`;
    default:
      return `${actor} changed guest access`;
  }
}

/**
 * Project a displayable state event into a `kind: 'event'` {@link MessageView}, given its
 * pre-computed `summary` (from {@link describeTimelineEvent}). Carries only what a system
 * line renders — everything message-specific is neutral/empty.
 */
export function buildTimelineEventView(
  client: MatrixClient,
  room: Room | undefined,
  event: MatrixEvent,
  summary: string,
): MessageView {
  const senderId = event.getSender() ?? '';
  const senderName = room?.getMember(senderId)?.name || senderId || 'Someone';
  return {
    id: event.getId() ?? '',
    senderId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: null,
    body: summary,
    html: null,
    timestamp: event.getTs(),
    isOwn: senderId === client.getUserId(),
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'event',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
    location: null,
    shield: null,
    previewUrl: null,
    previewEncrypted: true,
    summary,
  };
}
