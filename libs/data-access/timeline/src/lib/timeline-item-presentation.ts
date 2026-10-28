import { MAX_NAMED_REACTORS, initialOf } from '@trinity/util/matrix';
import type {
  NormalizedSystemChange,
  NormalizedTimelineEvent,
  ReactionView,
  ReceiptView,
  ReplyPreview,
  UndecryptableReason,
} from './message-presentation';
import { shieldText, unencryptedShield } from './shield-presentation';
import type {
  EventTimelineItem,
  Profile,
  SystemChange,
} from './timeline-engine';

/** The name js-sdk's `RoomMember.name` gives: the user id is added to an ambiguous name. */
export function profileName(
  userId: string,
  profile: Profile | undefined,
): string {
  if (!profile?.displayName) return userId;
  return profile.displayNameAmbiguous
    ? `${profile.displayName} (${userId})`
    : profile.displayName;
}

/**
 * The {@link NormalizedTimelineEvent} an item was made from, its names resolved from its
 * profiles. `room.encrypted` is whether the room has an `m.room.encryption` state event.
 */
export function normalizedFromItem(
  item: EventTimelineItem,
  room: {
    readonly roomId: string;
    readonly encrypted: boolean;
    /** The account viewing the room; its own reaction reads "You". */
    readonly viewerId: string;
  },
): NormalizedTimelineEvent {
  const name = (userId: string): string =>
    profileName(userId, item.profiles[userId]);
  const senderName = name(item.sender) || 'Unknown';
  const common = {
    id:
      item.eventId ??
      (item.transactionId ? `~${room.roomId}:${item.transactionId}` : ''),
    senderId: item.sender,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: item.profiles[item.sender]?.avatarMxc ?? null,
    timestamp: item.timestamp,
    isOwn: item.isOwn,
    edited: item.edited,
    reactions: item.reactions.map((group): ReactionView => ({
      key: group.key,
      count: group.count,
      reacted: group.reactedByMe,
      reactors: reactorNames(
        group.senders,
        group.reactedByMe,
        room.viewerId,
        name,
      ),
    })),
    replyTo: replyPreview(item, name),
    status: item.sendState?.kind ?? null,
    readReceipts: item.readBy.map((userId): ReceiptView => {
      const readerName = name(userId);
      return {
        userId,
        name: readerName,
        initial: initialOf(readerName),
        avatarMxc: item.profiles[userId]?.avatarMxc ?? null,
      };
    }),
    shield:
      unencryptedShield(item.unencryptedMark) ??
      (item.shield ? shieldText(item.shield) : null),
  };
  const mentionNames = (mentions: readonly string[]) =>
    Object.fromEntries(
      mentions
        .map((userId) => [userId, name(userId)] as const)
        .filter(([userId, mention]) => mention && mention !== userId),
    );
  const content = item.content;
  switch (content.kind) {
    case 'message':
      return {
        ...common,
        type: 'text',
        messageKind: content.msgtype,
        body: content.body,
        formattedBody: content.formattedBody,
        replyFallback: content.replyFallback,
        addressesViewer: content.mentionsMe,
        mentionNames: mentionNames(content.mentions),
        roomEncrypted: room.encrypted,
        roomId: room.roomId,
      };
    case 'media':
      return {
        ...common,
        type: 'media',
        messageKind: content.msgtype,
        media: content.source,
        body: content.body,
        caption: content.caption,
        formattedCaption: content.formattedCaption,
        replyFallback: content.replyFallback,
        addressesViewer: content.mentionsMe,
        mentionNames: mentionNames(content.mentions),
      };
    case 'sticker':
      return {
        ...common,
        type: 'media',
        messageKind: 'sticker',
        media: content.source,
        body: content.body,
        caption: null,
        formattedCaption: null,
        replyFallback: false,
        addressesViewer: false,
        mentionNames: {},
      };
    case 'location':
      return {
        ...common,
        type: 'location',
        body: content.label,
        location: { lat: content.lat, lng: content.lng, label: content.label },
      };
    case 'poll':
      return { ...common, type: 'poll', poll: content.poll };
    case 'state':
      return {
        ...common,
        type: 'system',
        change: namedChange(content.change, name),
      };
    case 'redacted':
      return unsupported(common, 'redacted-message', '', content, null);
    case 'unableToDecrypt':
      return unsupported(
        common,
        'undecryptable-message',
        '',
        content,
        content.reason,
      );
    case 'unsupported':
      return unsupported(common, 'unsupported-message', content.body, content);
  }
}

type UnsupportedFallback = Extract<
  NormalizedTimelineEvent,
  { type: 'unsupported' }
>['fallback'];

function unsupported<Common>(
  common: Common,
  fallback: UnsupportedFallback,
  body: string,
  { replyFallback }: { readonly replyFallback: boolean },
  undecryptableReason: UndecryptableReason | null = null,
) {
  return {
    ...common,
    type: 'unsupported' as const,
    fallback,
    decryptionFailed: fallback === 'undecryptable-message',
    body,
    replyFallback,
    undecryptableReason,
  };
}

/** As js-sdk names a pill's reactors: "You" first, then the others, up to the cap. */
function reactorNames(
  senders: readonly string[],
  reactedByMe: boolean,
  viewerId: string,
  name: (userId: string) => string,
): string[] {
  const names = reactedByMe ? ['You'] : [];
  for (const userId of senders) {
    if (names.length >= MAX_NAMED_REACTORS) break;
    if (userId !== viewerId) names.push(name(userId));
  }
  return names;
}

/** The quote a reply shows, or null while its target is not loaded. */
function replyPreview(
  item: EventTimelineItem,
  name: (userId: string) => string,
): ReplyPreview | null {
  const details = item.inReplyTo?.details;
  if (!item.inReplyTo || details?.kind !== 'ready') return null;
  const senderName = name(details.sender);
  return {
    id: item.inReplyTo.eventId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: item.profiles[details.sender]?.avatarMxc ?? null,
    body: details.redacted
      ? '(message deleted)'
      : details.body.replace(/\s+/g, ' ').trim() || '…',
    shield: unencryptedShield(details.unencryptedMark),
  };
}

/** A system change with its actor's and target's names resolved. */
function namedChange(
  change: SystemChange,
  name: (userId: string) => string,
): NormalizedSystemChange {
  const { actorId, ...rest } = change;
  const actorName = name(actorId) || 'Someone';
  return rest.kind === 'membership'
    ? {
        ...rest,
        actorName,
        targetName: (rest.displayName ?? name(rest.targetId)) || 'Someone',
      }
    : ({ ...rest, actorName } as NormalizedSystemChange);
}
