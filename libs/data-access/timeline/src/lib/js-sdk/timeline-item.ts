import type {
  MatrixClient,
  MatrixEvent,
  Room,
  RoomMember,
} from 'matrix-js-sdk';
import {
  MAX_NAMED_REACTORS,
  linkedUserIds,
  unencryptedMarkFor,
  type UnencryptedMark,
} from '@trinity/util/matrix';
import type { NormalizedTimelineEvent } from '../message-presentation';
import { shieldText, unencryptedShield } from '../shield-presentation';
import type {
  EventTimelineItem,
  InReplyTo,
  Profile,
  ReactionGroup,
  SendState,
  ShieldCode,
  SystemChange,
  TimelineItemContent,
} from '../timeline-engine';
import { reactionSendersFor, readReceiptUserIds } from './event-reads';
import { normalizeTimelineEvent } from './normalize-timeline-event';
import { shownContent, shownSubject } from './shields';

function read<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** A JSON copy: drops `undefined` keys, so the value crosses the engine boundary. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The transaction id of a local echo, or of its remote echo on the sending device. */
function transactionIdOf(event: MatrixEvent): string | null {
  const txnId = read<unknown>(
    () => event.getTxnId?.() ?? event.getUnsigned?.()?.transaction_id,
    null,
  );
  return typeof txnId === 'string' && txnId !== '' ? txnId : null;
}

/** The profile `RoomMember.name` is built from; null when the member has no usable name. */
export function profileOf(
  userId: string,
  member: RoomMember | null | undefined,
): Profile | null {
  const name = read<unknown>(() => member?.name, null);
  if (!member || typeof name !== 'string') return null;
  const avatar = read<unknown>(() => member.getMxcAvatarUrl() ?? null, null);
  const avatarMxc = typeof avatar === 'string' ? avatar : null;
  if (name === '' || name === userId) {
    return { displayName: null, displayNameAmbiguous: false, avatarMxc };
  }
  const raw = read<unknown>(() => member.rawDisplayName, null);
  const ambiguous =
    member.disambiguate === true &&
    typeof raw === 'string' &&
    name === `${raw} (${userId})`;
  return {
    displayName: ambiguous ? (raw as string) : name,
    displayNameAmbiguous: ambiguous,
    avatarMxc,
  };
}

function sendStateOf(
  status: NormalizedTimelineEvent['status'],
): SendState | null {
  switch (status) {
    case 'sending':
    case 'waiting':
      return { kind: status };
    case 'failed':
      return { kind: 'failed', recoverable: true };
    default:
      return null;
  }
}

function markOf(
  normalized: NormalizedTimelineEvent['replyTo'],
): UnencryptedMark | null {
  const level = normalized?.shield?.level;
  return level === 'unencrypted' || level === 'unencrypted-history'
    ? level
    : null;
}

function inReplyToOf(
  room: Room,
  event: MatrixEvent,
  normalized: NormalizedTimelineEvent,
): InReplyTo | null {
  const quote = normalized.replyTo;
  if (!quote) {
    const replyId = read(() => event.replyEventId, undefined);
    const relation = read<Record<string, unknown> | null>(
      () => event.getRelation() as Record<string, unknown> | null,
      null,
    );
    // A thread fallback is not an explicit reply.
    const fallback =
      relation?.['rel_type'] === 'm.thread' &&
      relation['is_falling_back'] === true;
    return replyId && !fallback
      ? { eventId: replyId, details: { kind: 'unavailable' } }
      : null;
  }
  const target = read(() => room.findEventById(quote.id), undefined);
  const redacted = read(() => target?.isRedacted() ?? false, false);
  return {
    eventId: quote.id,
    details: {
      kind: 'ready',
      sender: read(() => target?.getSender() ?? '', ''),
      body: redacted ? '' : quote.body,
      redacted,
      unencryptedMark: markOf(quote),
    },
  };
}

function reactionGroupsOf(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionGroup[] {
  const me = read(() => client.getUserId(), null);
  return read(
    () =>
      reactionSendersFor(room, event).map(([key, senders]) => ({
        key,
        count: senders.length,
        reactedByMe: senders.includes(me ?? ''),
        senders: senders.slice(0, MAX_NAMED_REACTORS),
      })),
    [],
  );
}

function contentOf(
  event: MatrixEvent,
  normalized: NormalizedTimelineEvent,
): { content: TimelineItemContent; named: readonly string[] } {
  switch (normalized.type) {
    case 'text': {
      const mentions = linkedUserIds(normalized.formattedBody);
      return {
        content: {
          kind: 'message',
          msgtype: normalized.messageKind,
          body: normalized.body,
          formattedBody: normalized.formattedBody,
          replyFallback: normalized.replyFallback,
          mentionsMe: normalized.addressesViewer,
          mentions,
        },
        named: mentions,
      };
    }
    case 'media': {
      const source = plain(normalized.media);
      if (normalized.messageKind === 'sticker') {
        const raw = read(() => shownContent(event), {});
        const info = raw['info'];
        return {
          content: {
            kind: 'sticker',
            source,
            body: typeof raw['body'] === 'string' ? raw['body'] : null,
            url: typeof raw['url'] === 'string' ? raw['url'] : null,
            info:
              typeof info === 'object' && info !== null && !Array.isArray(info)
                ? plain(info as Record<string, unknown>)
                : null,
          },
          named: [],
        };
      }
      const mentions = linkedUserIds(normalized.formattedCaption);
      return {
        content: {
          kind: 'media',
          msgtype: normalized.messageKind,
          source,
          body: normalized.body,
          caption: normalized.caption,
          formattedCaption: normalized.formattedCaption,
          replyFallback: normalized.replyFallback,
          mentionsMe: normalized.addressesViewer,
          mentions,
        },
        named: mentions,
      };
    }
    case 'location':
      return {
        content: {
          kind: 'location',
          lat: normalized.location.lat,
          lng: normalized.location.lng,
          label: normalized.location.label,
        },
        named: [],
      };
    case 'poll':
      return { content: { kind: 'poll', poll: normalized.poll }, named: [] };
    case 'system': {
      // The item names users by id; their names come back from the profiles.
      const change: Record<string, unknown> = {
        ...normalized.change,
        actorId: normalized.senderId,
      };
      delete change['actorName'];
      delete change['targetName'];
      const target =
        normalized.change.kind === 'membership'
          ? [normalized.change.targetId]
          : [];
      return {
        content: { kind: 'state', change: change as SystemChange },
        named: [normalized.senderId, ...target],
      };
    }
    case 'unsupported':
      switch (normalized.fallback) {
        case 'redacted-message':
          return {
            content: {
              kind: 'redacted',
              replyFallback: normalized.replyFallback,
            },
            named: [],
          };
        case 'undecryptable-message':
          return {
            content: {
              kind: 'unableToDecrypt',
              reason: normalized.undecryptableReason ?? null,
              replyFallback: normalized.replyFallback,
            },
            named: [],
          };
        case 'unsupported-message':
          return {
            content: {
              kind: 'unsupported',
              body: normalized.body,
              replyFallback: normalized.replyFallback,
            },
            named: [],
          };
      }
  }
}

/**
 * The item for one event, or null for an event that renders nothing. Runs the normalizer,
 * then trades its names for user ids and `profiles`, and its shield text for codes.
 */
export function toTimelineItem(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: ShieldCode | null,
  roomEncrypted: boolean,
): EventTimelineItem | null {
  const mark = read(
    () => unencryptedMarkFor(room, roomEncrypted)(event, shownSubject(event)),
    null,
  );
  const normalized = normalizeTimelineEvent(
    client,
    room,
    event,
    unencryptedShield(mark) ?? (shield ? shieldText(shield) : null),
    roomEncrypted,
  );
  if (!normalized) return null;
  const { content, named } = contentOf(event, normalized);
  const inReplyTo = inReplyToOf(room, event, normalized);
  const reactions = reactionGroupsOf(client, room, event);
  const readBy = read(() => readReceiptUserIds(client, room, event), []);
  const transactionId = transactionIdOf(event);
  const id = normalized.id;
  const eventId = id === '' || id.startsWith('~') ? null : id;

  const profiles: Record<string, Profile> = {};
  const ids = [
    normalized.senderId,
    ...(inReplyTo?.details.kind === 'ready' ? [inReplyTo.details.sender] : []),
    ...reactions.flatMap((group) => group.senders),
    ...readBy,
    ...named,
  ];
  for (const userId of ids) {
    if (!userId || userId in profiles) continue;
    const profile = profileOf(
      userId,
      read(() => room.getMember(userId), null),
    );
    if (profile) profiles[userId] = profile;
  }

  return {
    kind: 'event',
    uniqueId: transactionId ? `txn:${transactionId}` : `ev:${id}`,
    eventId,
    transactionId,
    sender: normalized.senderId,
    isOwn: normalized.isOwn,
    timestamp: normalized.timestamp,
    sendState: sendStateOf(normalized.status),
    content,
    edited: normalized.edited,
    inReplyTo,
    reactions,
    readBy,
    shield,
    unencryptedMark: mark,
    profiles,
  };
}
