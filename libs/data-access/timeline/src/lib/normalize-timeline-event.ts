import {
  EventType,
  MsgType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  initialOf,
  mapStatus,
  reactionsFor,
  readReceiptsFor,
  replyPreview,
} from '@trinity/util/matrix';
import type {
  MessageShield,
  NormalizedSystemChange,
  NormalizedTimelineEvent,
  ReactionView,
  ReceiptView,
  ReplyPreview,
} from './message-presentation';

const SYSTEM_EVENT_TYPES = new Set<string>([
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

const LEGACY_MESSAGE_TYPES = new Set<unknown>([
  MsgType.Image,
  MsgType.File,
  MsgType.Audio,
  MsgType.Video,
  MsgType.Location,
]);

/** Whether a raw event is a supported, non-redacted Matrix system event. */
export function isPresentableSystemEvent(event: MatrixEvent): boolean {
  return read(
    () =>
      event.isState() &&
      !event.isRedacted() &&
      SYSTEM_EVENT_TYPES.has(event.getType()),
    false,
  );
}

function read<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mentionsViewer(
  content: Readonly<Record<string, unknown>>,
  viewerId: string,
): boolean {
  if (viewerId === '') return false;
  const mentions = record(content['m.mentions']);
  const userIds = mentions['user_ids'];
  return (
    Array.isArray(userIds) &&
    userIds.some((value) => typeof value === 'string' && value === viewerId)
  );
}

function normalizeReactions(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): readonly ReactionView[] {
  return Object.freeze(
    read(
      () =>
        reactionsFor(client, room, event).map((reaction) =>
          Object.freeze({
            key: reaction.key,
            count: reaction.count,
            reacted: reaction.reacted,
            reactors: Object.freeze([...reaction.reactors]),
          }),
        ),
      [],
    ),
  );
}

function normalizeReceipts(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): readonly ReceiptView[] {
  return Object.freeze(
    read(
      () =>
        readReceiptsFor(client, room, event).map((receipt) =>
          Object.freeze({ ...receipt }),
        ),
      [],
    ),
  );
}

function normalizeReply(room: Room, event: MatrixEvent): ReplyPreview | null {
  const eventId = read(() => event.replyEventId, undefined);
  if (!eventId) return null;
  const preview = read(() => replyPreview(room, eventId), null);
  return preview ? Object.freeze({ ...preview }) : null;
}

function normalizeCommon(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null,
) {
  const senderId = string(read<unknown>(() => event.getSender(), null)) ?? '';
  const member = read(() => room.getMember(senderId), null);
  const memberName = read<unknown>(() => member?.name, null);
  const senderName =
    (typeof memberName === 'string' && memberName !== ''
      ? memberName
      : senderId) || 'Unknown';
  const avatar = read<unknown>(() => member?.getMxcAvatarUrl() ?? null, null);
  const avatarMxc = typeof avatar === 'string' ? avatar : null;
  return {
    id: string(read<unknown>(() => event.getId(), null)) ?? '',
    senderId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: avatarMxc,
    timestamp: finiteNumber(read<unknown>(() => event.getTs(), 0)),
    isOwn: read(() => senderId === client.getUserId(), false),
    edited: read(() => event.replacingEvent() !== null, false),
    reactions: normalizeReactions(client, room, event),
    replyTo: normalizeReply(room, event),
    status: read(() => mapStatus(event.status), null),
    readReceipts: normalizeReceipts(client, room, event),
    shield: shield ? Object.freeze({ ...shield }) : null,
  } as const;
}

function unsupported(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null,
  fallback:
    'unsupported-message' | 'undecryptable-message' | 'redacted-message',
  decryptionFailed: boolean,
  body = '',
): NormalizedTimelineEvent {
  return Object.freeze({
    ...normalizeCommon(client, room, event, shield),
    type: 'unsupported',
    fallback,
    decryptionFailed,
    body,
    replyFallback: read(() => Boolean(event.replyEventId), false),
  });
}

function actorName(event: MatrixEvent, room: Room): string {
  const sender = string(read<unknown>(() => event.getSender(), null)) ?? '';
  const memberName = string(
    read<unknown>(() => room.getMember(sender)?.name, null),
  );
  return (memberName ?? sender) || 'Someone';
}

function nameFor(
  room: Room,
  userId: string,
  displayName: string | null,
): string {
  const memberName = string(
    read<unknown>(() => room.getMember(userId)?.name, null),
  );
  return (displayName ?? memberName ?? userId) || 'Someone';
}

function normalizeSystemChange(
  event: MatrixEvent,
  room: Room,
  type: string,
  content: Readonly<Record<string, unknown>>,
  previous: Readonly<Record<string, unknown>>,
): NormalizedSystemChange | null {
  const actor = actorName(event, room);
  switch (type) {
    case EventType.RoomMember: {
      const targetId =
        string(read<unknown>(() => event.getStateKey(), null)) ?? '';
      const displayName = string(content['displayname']);
      return {
        kind: 'membership',
        membership: string(content['membership']),
        previousMembership: string(previous['membership']),
        actorName: actor,
        actorIsTarget: read(() => event.getSender() === targetId, false),
        targetId,
        targetName: nameFor(room, targetId, displayName),
        previousDisplayName: string(previous['displayname']),
        displayName,
        avatarChanged: previous['avatar_url'] !== content['avatar_url'],
        reason: string(content['reason']),
      };
    }
    case EventType.RoomName:
      return {
        kind: 'room-name',
        actorName: actor,
        previousName: string(previous['name']),
        name: string(content['name']),
      };
    case EventType.RoomTopic:
      return {
        kind: 'room-topic',
        actorName: actor,
        previousTopic: string(previous['topic']),
        topic: string(content['topic']),
      };
    case EventType.RoomAvatar:
      return {
        kind: 'room-avatar',
        actorName: actor,
        previousUrl: string(previous['url']),
        url: string(content['url']),
      };
    case EventType.RoomCanonicalAlias:
      return {
        kind: 'canonical-alias',
        actorName: actor,
        previousAlias: string(previous['alias']),
        alias: string(content['alias']),
      };
    case EventType.RoomJoinRules:
      return {
        kind: 'join-rules',
        actorName: actor,
        previousRule: string(previous['join_rule']),
        rule: string(content['join_rule']),
      };
    case EventType.RoomHistoryVisibility:
      return {
        kind: 'history-visibility',
        actorName: actor,
        previousVisibility: string(previous['history_visibility']),
        visibility: string(content['history_visibility']),
      };
    case EventType.RoomGuestAccess:
      return {
        kind: 'guest-access',
        actorName: actor,
        previousAccess: string(previous['guest_access']),
        access: string(content['guest_access']),
      };
    case EventType.RoomEncryption:
      return { kind: 'encryption', actorName: actor };
    case EventType.RoomCreate:
      return { kind: 'create', actorName: actor };
    default:
      return null;
  }
}

/**
 * Matrix adapter for the #305 slice. It either returns a frozen, SDK-free text/system
 * record, an explicit safe fallback, or null when a later migration owns the event kind.
 */
export function normalizeTimelineEvent(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null,
): NormalizedTimelineEvent | null {
  const type = read(() => event.getType(), '');
  const decryptionFailed = read(() => event.isDecryptionFailure(), false);
  if (decryptionFailed) {
    return unsupported(
      client,
      room,
      event,
      shield,
      'undecryptable-message',
      true,
    );
  }
  if (read(() => event.isRedacted(), false)) {
    return unsupported(client, room, event, shield, 'redacted-message', false);
  }

  if (SYSTEM_EVENT_TYPES.has(type)) {
    if (!read(() => event.isState(), false)) return null;
    try {
      const content = record(event.getContent());
      const previous = record(event.getPrevContent());
      const change = normalizeSystemChange(
        event,
        room,
        type,
        content,
        previous,
      );
      return change
        ? Object.freeze({
            ...normalizeCommon(client, room, event, shield),
            type: 'system',
            change: Object.freeze(change),
          })
        : null;
    } catch {
      return unsupported(
        client,
        room,
        event,
        shield,
        'unsupported-message',
        false,
      );
    }
  }

  if (type !== EventType.RoomMessage) return null;
  try {
    const content = record(event.getContent());
    const msgtype = content['msgtype'];
    if (LEGACY_MESSAGE_TYPES.has(msgtype)) return null;
    if (
      msgtype !== MsgType.Text &&
      msgtype !== MsgType.Emote &&
      msgtype !== MsgType.Notice
    ) {
      return unsupported(
        client,
        room,
        event,
        shield,
        'unsupported-message',
        false,
        typeof content['body'] === 'string' ? content['body'] : '',
      );
    }
    if (typeof content['body'] !== 'string') {
      return unsupported(
        client,
        room,
        event,
        shield,
        'unsupported-message',
        false,
      );
    }
    const viewerId =
      string(read<unknown>(() => client.getUserId(), null)) ?? '';
    return Object.freeze({
      ...normalizeCommon(client, room, event, shield),
      type: 'text',
      messageKind:
        msgtype === MsgType.Emote
          ? 'emote'
          : msgtype === MsgType.Notice
            ? 'notice'
            : 'text',
      body: content['body'],
      formattedBody:
        content['format'] === 'org.matrix.custom.html' &&
        typeof content['formatted_body'] === 'string'
          ? content['formatted_body']
          : null,
      replyFallback: read(() => Boolean(event.replyEventId), false),
      addressesViewer: mentionsViewer(content, viewerId),
      roomEncrypted: read(() => room.hasEncryptionStateEvent?.() ?? true, true),
    });
  } catch {
    return unsupported(
      client,
      room,
      event,
      shield,
      'unsupported-message',
      false,
    );
  }
}
