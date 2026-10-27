import {
  EventStatus,
  EventType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  MAX_NAMED_REACTORS,
  displayContent,
  initialOf,
  isWaitingToSend,
  linkedUserIds,
  shieldSubject,
  stripReplyFallbackText,
  unencryptedMarkFor,
  type ReplyPreview,
} from '@trinity/util/matrix';
import type {
  ReactionDetail,
  ReactionView,
  ReceiptView,
} from '../message-presentation';
import { isPollStart, pollEndSenders } from './poll-reads';

/** How many receipt avatars to show on a message before it gets noisy. */
const MAX_RECEIPTS = 5;

/**
 * User ids whose read receipt sits on this event, capped. Excludes the local user and
 * the event's author, whose receipt on their own message carries no information.
 */
export function readReceiptUserIds(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string[] {
  const selfId = client.getUserId();
  const senderId = event.getSender();
  return (room.getUsersReadUpTo?.(event) ?? [])
    .filter((id) => id !== selfId && id !== senderId)
    .slice(0, MAX_RECEIPTS);
}

/** The "seen by" receipts for this event: members whose read marker sits on it. */
export function readReceiptsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReceiptView[] {
  return readReceiptUserIds(client, room, event).map((userId) => {
    const member = room.getMember(userId);
    const name = member?.name || userId;
    return {
      userId,
      name,
      initial: initialOf(name),
      avatarMxc: member?.getMxcAvatarUrl() ?? null,
    };
  });
}

/**
 * True when an event should render as a message row (message, sticker, or poll). A state
 * event never is, whatever its type: it is room state, not a turn in the conversation.
 */
export function isDisplayableMessage(event: MatrixEvent): boolean {
  if (event.isState()) {
    return false;
  }
  if (isPollStart(event)) {
    return true;
  }
  return (
    (event.getType() === EventType.RoomMessage ||
      event.getType() === EventType.Sticker) &&
    !event.isRelation(RelationType.Replace)
  );
}

/**
 * Build a short preview of a replied-to message, or null if it isn't loaded. Text that arrived
 * unencrypted in an encrypted room is quoted too, with the `mark` the room list gives it (see
 * {@link unencryptedMarkFor}): the quote sits inside the replying message, so the mark keeps its
 * shield from vouching for it. `contentOf` picks what of it to show and `subjectOf` the event
 * that text came from, which the mark judges; a timeline passes what the quoted message's own
 * row shows.
 */
export function replyPreview(
  room: Room,
  eventId: string,
  roomEncrypted: boolean,
  contentOf: (event: MatrixEvent) => Record<string, unknown> = displayContent,
  subjectOf: (event: MatrixEvent) => MatrixEvent = shieldSubject,
): ReplyPreview | null {
  const target = room.findEventById(eventId);
  if (!target) {
    return null;
  }
  const sender = target.getSender() ?? '';
  const member = room.getMember(sender);
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  const senderName = member?.name || sender;
  const redacted = target.isRedacted();
  const raw = redacted
    ? '(message deleted)'
    : stripReplyFallbackText((contentOf(target)['body'] as string) ?? '');
  return {
    id: eventId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
    body: raw.replace(/\s+/g, ' ').trim() || '…',
    mark: redacted
      ? null
      : unencryptedMarkFor(room, roomEncrypted)(target, subjectOf(target)),
  };
}

/**
 * Add the user ids whose room membership a rendered message depends on into `into`: the sender,
 * the quoted sender in a reply preview, the reactors a pill names, and the readers behind its
 * "seen by" receipts. A projection re-maps only when one of these members loads or changes, not
 * on every member update in a large room.
 *
 * Each group is bounded (the reply target only while loaded, reactors at `MAX_NAMED_REACTORS`,
 * readers at `MAX_RECEIPTS`), so the set tracks what is on screen, not the room's membership.
 */
export function collectMessageSenders(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  into: Set<string>,
  /**
   * Pass `{ receipts: false }` for a row that renders no "seen by" avatars (a system line, built
   * with `readReceipts: []`): collecting its readers would widen the gate this feeds.
   */
  options: { receipts?: boolean } = {},
): void {
  const sender = event.getSender();
  if (sender) {
    into.add(sender);
  }
  const replyId = event.replyEventId;
  if (replyId) {
    const targetSender = room.findEventById(replyId)?.getSender();
    if (targetSender) {
      into.add(targetSender);
    }
  }
  // Mention pills show the linked member's name.
  const content = displayContent(event);
  if (content['format'] === 'org.matrix.custom.html') {
    for (const userId of linkedUserIds(
      typeof content['formatted_body'] === 'string'
        ? content['formatted_body']
        : null,
    )) {
      into.add(userId);
    }
  }
  // Only the named reactors: nobody beyond the cap renders, so nobody beyond it needs re-mapping.
  for (const [, reactions] of reactionEventsFor(room, event)) {
    for (const reaction of reactions.slice(0, MAX_NAMED_REACTORS)) {
      const reactor = reaction.getSender();
      if (reactor) {
        into.add(reactor);
      }
    }
  }
  // A poll's state follows who ended it, so their power and membership changes re-map it.
  if (isPollStart(event)) {
    for (const ender of pollEndSenders(room, event)) {
      into.add(ender);
    }
  }
  // Readers render as avatars like the sender. One who never posted in the loaded window is
  // reachable only here, so without this their member event is discarded at the gate.
  if (options.receipts !== false) {
    for (const reader of readReceiptUserIds(client, room, event)) {
      into.add(reader);
    }
  }
}

/**
 * An event's live reactions grouped by key, one per sender, ordered by that count with the key
 * seen first (its earliest reaction) breaking ties. Redacted ones and empty keys are dropped.
 * Shared by the pills and the "who reacted" list.
 *
 * The SDK dedupes annotations by event id only, and only the sender's homeserver refuses a
 * repeat, so a federated sender can send one key many times; counting senders keeps that from
 * inflating a count or, through the SDK's count-ordered list, a key's position. Keys are grouped
 * exactly as sent: lookalikes (a variation selector, a zero-width character) stay separate.
 */
function reactionEventsFor(
  room: Room,
  event: MatrixEvent,
): [string, MatrixEvent[]][] {
  const id = event.getId();
  if (!id) {
    return [];
  }
  const annotations = room.relations
    .getChildEventsForEvent(id, RelationType.Annotation, EventType.Reaction)
    ?.getSortedAnnotationsByKey();
  if (!annotations) {
    return [];
  }
  const groups: [string, MatrixEvent[]][] = [];
  for (const [key, set] of annotations) {
    const bySender = new Map<string, MatrixEvent>();
    for (const e of set) {
      const sender = e.getSender();
      if (sender && !e.isRedacted() && !bySender.has(sender)) {
        bySender.set(sender, e);
      }
    }
    if (bySender.size > 0) {
      groups.push([key, [...bySender.values()]]);
    }
  }
  const firstSeen = ([, events]: [string, MatrixEvent[]]) =>
    events.reduce((min, e) => Math.min(min, e.getTs()), Infinity);
  return groups.sort(
    (a, b) => b[1].length - a[1].length || firstSeen(a) - firstSeen(b),
  );
}

/** Each reaction key with its senders' user ids, ordered as {@link reactionsFor} orders them. */
export function reactionSendersFor(
  room: Room,
  event: MatrixEvent,
): [string, string[]][] {
  return reactionEventsFor(room, event).map(([key, reactions]) => [
    key,
    reactions.map((reaction) => reaction.getSender() ?? ''),
  ]);
}

/** A member's resolved display name, falling back to the raw mxid. */
function displayNameOf(room: Room, userId: string): string {
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  return room.getMember(userId)?.name || userId;
}

/** Read aggregated reactions for an event from the room's relations. */
export function reactionsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionView[] {
  const myId = client.getUserId();
  return reactionEventsFor(room, event).map(([key, reactions]) => ({
    key,
    count: reactions.length,
    reacted: reactions.some((e) => e.getSender() === myId),
    reactors: namedReactors(room, reactions, myId),
  }));
}

/** The first few reactors by display name, the local user first as "You". */
function namedReactors(
  room: Room,
  reactions: MatrixEvent[],
  myId: string | null,
): string[] {
  const names: string[] = [];
  if (reactions.some((e) => e.getSender() === myId)) {
    names.push('You');
  }
  for (const reaction of reactions) {
    if (names.length >= MAX_NAMED_REACTORS) {
      break;
    }
    const reactor = reaction.getSender();
    if (reactor && reactor !== myId) {
      names.push(displayNameOf(room, reactor));
    }
  }
  return names;
}

/**
 * Every reactor of every reaction on an event, grouped by key: the full list behind a pill's
 * capped {@link ReactionView.reactors}. Read on demand (when the "who reacted" dialog opens),
 * not carried on every {@link MessageView}.
 */
export function reactionDetailsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionDetail[] {
  const myId = client.getUserId();
  return reactionEventsFor(room, event).map(([key, reactions]) => ({
    key,
    reacted: reactions.some((e) => e.getSender() === myId),
    reactors: reactions.flatMap((reaction) => {
      const userId = reaction.getSender();
      if (!userId) {
        return [];
      }
      const name = displayNameOf(room, userId);
      return [
        {
          userId,
          name,
          initial: initialOf(name),
          avatarMxc: room.getMember(userId)?.getMxcAvatarUrl() ?? null,
        },
      ];
    }),
  }));
}

export function mapStatus(
  event: MatrixEvent,
): 'sending' | 'waiting' | 'failed' | null {
  const { status } = event;
  if (status === EventStatus.SENDING || status === EventStatus.QUEUED) {
    return 'sending';
  }
  if (status === EventStatus.NOT_SENT) {
    return isWaitingToSend(event) ? 'waiting' : 'failed';
  }
  return null;
}
