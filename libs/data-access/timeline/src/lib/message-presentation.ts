import {
  firstUrl,
  renderNormalizedTextBody,
  stripReplyFallbackText,
  type PollView,
} from '@trinity/util/matrix';
import { type PresentedMediaReference } from '@trinity/data-access/media';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** Timeline-owned, deeply immutable poll presentation payload. */
export type MessagePollView = DeepReadonly<PollView>;

export type MessageKind =
  | 'text'
  | 'emote'
  | 'notice'
  | 'redacted'
  | 'unsupported'
  | 'poll'
  | 'location'
  | 'sticker'
  | 'event'
  | 'image'
  | 'file'
  | 'video'
  | 'audio';

export type SystemLineCategory = 'membership' | 'profile' | 'room';

export interface MessageShield {
  readonly level: 'grey' | 'red';
  readonly reason: string;
  readonly explanation: string;
}

export interface ReactionView {
  readonly key: string;
  readonly count: number;
  readonly reacted: boolean;
  readonly reactors: readonly string[];
}

export interface ReactionReactor {
  readonly userId: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
}

export interface ReactionDetail {
  readonly key: string;
  readonly reacted: boolean;
  readonly reactors: readonly ReactionReactor[];
}

export interface ReplyPreview {
  readonly id: string;
  readonly senderName: string;
  readonly senderInitial: string;
  readonly senderAvatarMxc: string | null;
  readonly body: string;
}

export interface ReceiptView {
  readonly userId: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
}

export interface LocationView {
  readonly lat: number;
  readonly lng: number;
  readonly label: string;
}

/**
 * Immutable render model exposed by the Conversations capability.
 *
 * SDK objects end at the normalizer. This model contains only bounded plain data and
 * sanitized HTML, so feature code cannot accidentally re-read federated input or bypass
 * Message Presentation's URL and HTML policy.
 */
export interface MessageView {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly senderInitial: string;
  readonly senderAvatarMxc: string | null;
  readonly body: string;
  readonly html: string | null;
  readonly timestamp: number;
  readonly isOwn: boolean;
  readonly decryptionFailed: boolean;
  readonly edited: boolean;
  readonly reactions: readonly ReactionView[];
  readonly replyTo: ReplyPreview | null;
  readonly status: 'sending' | 'failed' | null;
  readonly kind: MessageKind;
  readonly media: PresentedMediaReference | null;
  readonly caption: string | null;
  readonly captionHtml: string | null;
  readonly readReceipts: readonly ReceiptView[];
  readonly poll: MessagePollView | null;
  readonly location?: LocationView | null;
  readonly shield?: MessageShield | null;
  readonly previewUrl?: string | null;
  readonly previewEncrypted?: boolean;
  readonly summary?: string | null;
  readonly systemCategory?: SystemLineCategory | null;
}

/** Whether the presented message can be edited as text. */
export function isEditableMessage(message: MessageView): boolean {
  return (
    message.isOwn &&
    !message.status &&
    !message.decryptionFailed &&
    (message.kind === 'text' ||
      message.kind === 'emote' ||
      message.kind === 'notice')
  );
}

/** Whether the presented body is meaningful input for the quote composer. */
export function isQuotableMessage(message: MessageView): boolean {
  return (
    !message.decryptionFailed &&
    (message.kind === 'text' ||
      message.kind === 'emote' ||
      message.kind === 'notice') &&
    message.body.trim() !== ''
  );
}

interface NormalizedCommon {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly senderInitial: string;
  readonly senderAvatarMxc: string | null;
  readonly timestamp: number;
  readonly isOwn: boolean;
  readonly edited: boolean;
  readonly reactions: readonly ReactionView[];
  readonly replyTo: ReplyPreview | null;
  readonly status: 'sending' | 'failed' | null;
  readonly readReceipts: readonly ReceiptView[];
  readonly shield: MessageShield | null;
}

export interface NormalizedTextEvent extends NormalizedCommon {
  readonly type: 'text';
  readonly messageKind: 'text' | 'emote' | 'notice';
  readonly body: string;
  readonly formattedBody: string | null;
  readonly replyFallback: boolean;
  readonly addressesViewer: boolean;
  readonly roomEncrypted: boolean;
}

export type NormalizedSystemChange =
  | {
      readonly kind: 'membership';
      readonly membership: string | null;
      readonly previousMembership: string | null;
      readonly actorName: string;
      readonly actorIsTarget: boolean;
      readonly targetId: string;
      readonly targetName: string;
      readonly previousDisplayName: string | null;
      readonly displayName: string | null;
      readonly avatarChanged: boolean;
      readonly reason: string | null;
    }
  | {
      readonly kind: 'room-name';
      readonly actorName: string;
      readonly previousName: string | null;
      readonly name: string | null;
    }
  | {
      readonly kind: 'room-topic';
      readonly actorName: string;
      readonly previousTopic: string | null;
      readonly topic: string | null;
    }
  | {
      readonly kind: 'room-avatar';
      readonly actorName: string;
      readonly previousUrl: string | null;
      readonly url: string | null;
    }
  | {
      readonly kind: 'canonical-alias';
      readonly actorName: string;
      readonly previousAlias: string | null;
      readonly alias: string | null;
    }
  | {
      readonly kind: 'join-rules';
      readonly actorName: string;
      readonly previousRule: string | null;
      readonly rule: string | null;
    }
  | {
      readonly kind: 'history-visibility';
      readonly actorName: string;
      readonly previousVisibility: string | null;
      readonly visibility: string | null;
    }
  | {
      readonly kind: 'guest-access';
      readonly actorName: string;
      readonly previousAccess: string | null;
      readonly access: string | null;
    }
  | { readonly kind: 'encryption'; readonly actorName: string }
  | { readonly kind: 'create'; readonly actorName: string };

export interface NormalizedSystemEvent extends NormalizedCommon {
  readonly type: 'system';
  readonly change: NormalizedSystemChange;
}

export interface NormalizedUnsupportedEvent extends NormalizedCommon {
  readonly type: 'unsupported';
  readonly fallback:
    'unsupported-message' | 'undecryptable-message' | 'redacted-message';
  readonly decryptionFailed: boolean;
  /** Safe plaintext retained for unsupported message types; empty for other fallbacks. */
  readonly body: string;
  readonly replyFallback: boolean;
}

export type NormalizedTimelineEvent =
  NormalizedTextEvent | NormalizedSystemEvent | NormalizedUnsupportedEvent;

export interface MessagePresentationMetrics {
  readonly eventCount: number;
  readonly durationMs: number;
  readonly averageEventDurationMs: number;
}

export interface MessagePresentationBatch {
  readonly messages: readonly MessageView[];
  readonly metrics: MessagePresentationMetrics;
}

interface SystemLine {
  readonly text: string;
  readonly category: SystemLineCategory;
}

const HISTORY_VISIBILITY: Readonly<Record<string, string>> = {
  world_readable: 'anyone, even without joining',
  shared: 'members, including history from before they joined',
  invited: 'members, from the point they were invited',
  joined: 'members, from the point they joined',
};

function systemLine(change: NormalizedSystemChange): SystemLine | null {
  switch (change.kind) {
    case 'membership':
      return membershipLine(change);
    case 'room-name': {
      if (change.name === change.previousName) return null;
      const text = change.name
        ? `${change.actorName} ${change.previousName ? 'changed' : 'set'} the room name to "${change.name}"`
        : `${change.actorName} removed the room name`;
      return { text, category: 'room' };
    }
    case 'room-topic': {
      if (change.topic === change.previousTopic) return null;
      const text = change.topic
        ? `${change.actorName} ${change.previousTopic ? 'changed' : 'set'} the room topic`
        : `${change.actorName} removed the room topic`;
      return { text, category: 'room' };
    }
    case 'room-avatar':
      if (change.url === change.previousUrl) return null;
      return {
        text: change.url
          ? `${change.actorName} changed the room avatar`
          : `${change.actorName} removed the room avatar`,
        category: 'room',
      };
    case 'canonical-alias':
      if (change.alias === change.previousAlias) return null;
      return {
        text: change.alias
          ? `${change.actorName} set the main address to ${change.alias}`
          : `${change.actorName} removed the main address`,
        category: 'room',
      };
    case 'join-rules': {
      if (change.rule === change.previousRule) return null;
      const suffix =
        change.rule === 'public'
          ? 'made the room public (anyone can join)'
          : change.rule === 'invite'
            ? 'made the room invite-only'
            : change.rule === 'knock'
              ? 'allowed people to request to join'
              : 'changed who can join the room';
      return { text: `${change.actorName} ${suffix}`, category: 'room' };
    }
    case 'history-visibility': {
      if (change.visibility === change.previousVisibility) return null;
      const audience = change.visibility
        ? HISTORY_VISIBILITY[change.visibility]
        : undefined;
      return {
        text: audience
          ? `${change.actorName} made future room history visible to ${audience}`
          : `${change.actorName} changed who can read history`,
        category: 'room',
      };
    }
    case 'guest-access': {
      if (change.access === change.previousAccess) return null;
      const suffix =
        change.access === 'can_join'
          ? 'allowed guests to join'
          : change.access === 'forbidden'
            ? 'stopped guests from joining'
            : 'changed guest access';
      return { text: `${change.actorName} ${suffix}`, category: 'room' };
    }
    case 'encryption':
      return {
        text: `${change.actorName} turned on end-to-end encryption`,
        category: 'room',
      };
    case 'create':
      return {
        text: `${change.actorName} created the room`,
        category: 'room',
      };
  }
}

function membershipLine(
  change: Extract<NormalizedSystemChange, { kind: 'membership' }>,
): SystemLine | null {
  const because = change.reason ? `: ${change.reason}` : '';
  switch (change.membership) {
    case 'join':
      if (change.previousMembership !== 'join') {
        return {
          text: `${change.targetName} joined the room`,
          category: 'membership',
        };
      }
      if (change.previousDisplayName !== change.displayName) {
        return {
          text: change.displayName
            ? `${change.previousDisplayName || change.targetId} changed their display name to "${change.displayName}"`
            : `${change.previousDisplayName || change.targetId} removed their display name`,
          category: 'profile',
        };
      }
      return change.avatarChanged
        ? {
            text: `${change.targetName} changed their profile picture`,
            category: 'profile',
          }
        : null;
    case 'invite':
      return {
        text: `${change.actorName} invited ${change.targetName}`,
        category: 'membership',
      };
    case 'knock':
      return {
        text: `${change.targetName} requested to join`,
        category: 'membership',
      };
    case 'ban':
      return {
        text: `${change.actorName} banned ${change.targetName}${because}`,
        category: 'membership',
      };
    case 'leave': {
      let text: string;
      if (change.previousMembership === 'ban') {
        text = `${change.actorName} unbanned ${change.targetName}`;
      } else if (change.actorIsTarget) {
        text =
          change.previousMembership === 'invite'
            ? `${change.targetName} rejected the invitation`
            : change.previousMembership === 'knock'
              ? `${change.targetName} cancelled their request to join`
              : `${change.targetName} left the room`;
      } else {
        text =
          change.previousMembership === 'invite'
            ? `${change.actorName} withdrew ${change.targetName}'s invitation`
            : `${change.actorName} removed ${change.targetName}${because}`;
      }
      return { text, category: 'membership' };
    }
    default:
      return null;
  }
}

function immutableCommon(event: NormalizedCommon) {
  const reactions = Object.freeze(
    event.reactions.map((reaction) =>
      Object.freeze({
        ...reaction,
        reactors: Object.freeze([...reaction.reactors]),
      }),
    ),
  );
  const readReceipts = Object.freeze(
    event.readReceipts.map((receipt) => Object.freeze({ ...receipt })),
  );
  return {
    id: event.id,
    senderId: event.senderId,
    senderName: event.senderName,
    senderInitial: event.senderInitial,
    senderAvatarMxc: event.senderAvatarMxc,
    timestamp: event.timestamp,
    isOwn: event.isOwn,
    edited: event.edited,
    reactions,
    replyTo: event.replyTo ? Object.freeze({ ...event.replyTo }) : null,
    status: event.status,
    readReceipts,
    shield: event.shield ? Object.freeze({ ...event.shield }) : null,
  } as const;
}

function neutral(common: ReturnType<typeof immutableCommon>) {
  return {
    ...common,
    media: null,
    caption: null,
    captionHtml: null,
    poll: null,
    location: null,
  } as const;
}

function immutableSystemCommon(event: NormalizedSystemEvent) {
  return {
    id: event.id,
    senderId: event.senderId,
    senderName: event.senderName,
    senderInitial: event.senderInitial,
    senderAvatarMxc: null,
    timestamp: event.timestamp,
    isOwn: event.isOwn,
    edited: false,
    reactions: Object.freeze([]),
    replyTo: null,
    status: null,
    readReceipts: Object.freeze([]),
    shield: null,
  } as const;
}

/** Present one already-normalized event; null means a supported no-op system change. */
export function presentNormalizedTimelineEvent(
  event: NormalizedTimelineEvent,
): MessageView | null {
  if (event.type === 'text') {
    const common = immutableCommon(event);
    const rendered = renderNormalizedTextBody(
      event.body,
      event.formattedBody,
      event.replyFallback,
      event.addressesViewer,
    );
    return Object.freeze({
      ...neutral(common),
      body: rendered.text,
      html: rendered.textHtml,
      decryptionFailed: false,
      kind: event.messageKind,
      previewUrl: event.messageKind === 'text' ? firstUrl(rendered.text) : null,
      previewEncrypted: event.roomEncrypted,
      summary: null,
      systemCategory: null,
    });
  }

  if (event.type === 'system') {
    const line = systemLine(event.change);
    if (!line) return null;
    return Object.freeze({
      ...neutral(immutableSystemCommon(event)),
      body: line.text,
      html: null,
      decryptionFailed: false,
      kind: 'event',
      previewUrl: null,
      previewEncrypted: true,
      summary: line.text,
      systemCategory: line.category,
    });
  }

  const redacted = event.fallback === 'redacted-message';
  const body =
    event.fallback === 'undecryptable-message'
      ? '⚠️ Unable to decrypt this message'
      : redacted
        ? '(message deleted)'
        : (event.replyFallback
            ? stripReplyFallbackText(event.body)
            : event.body) || '[unsupported message]';
  return Object.freeze({
    ...neutral(immutableCommon(event)),
    body,
    html: null,
    decryptionFailed: event.decryptionFailed,
    kind: redacted ? 'redacted' : 'unsupported',
    previewUrl: null,
    previewEncrypted: true,
    summary: null,
    systemCategory: null,
  });
}

/**
 * Present a representative batch and report content-free timing evidence. Diagnostics
 * intentionally contain counts and durations only: message bodies and Matrix identifiers
 * must never enter telemetry.
 */
export function presentNormalizedTimelineEvents(
  events: readonly NormalizedTimelineEvent[],
): MessagePresentationBatch {
  const startedAt = performance.now();
  const messages = Object.freeze(
    events.flatMap((event) => {
      const message = presentNormalizedTimelineEvent(event);
      return message ? [message] : [];
    }),
  );
  const durationMs = performance.now() - startedAt;
  return Object.freeze({
    messages,
    metrics: Object.freeze({
      eventCount: events.length,
      durationMs,
      averageEventDurationMs:
        events.length === 0 ? 0 : durationMs / events.length,
    }),
  });
}
