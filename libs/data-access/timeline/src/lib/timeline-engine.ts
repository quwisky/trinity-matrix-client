import type { Observable } from 'rxjs';
import type {
  EngineResult,
  MediaPayload,
  PollView,
  UnencryptedMark,
  VectorDiff,
} from '@trinity/util/matrix';
import type {
  NormalizedSystemChange,
  UndecryptableReason,
} from './message-presentation';

/** `live` hides thread replies; `thread` shows one thread. */
export type TimelineFocus =
  | { readonly kind: 'live' }
  | { readonly kind: 'thread'; readonly rootEventId: string };

/** An event by its id, or a local echo by its transaction id until the id is known. */
export interface TimelineItemKey {
  readonly eventId: string | null;
  readonly transactionId: string | null;
}

/** Text whose markdown, slash command and mention pills the caller has already rendered. */
export interface OutgoingText {
  readonly msgtype: 'text' | 'emote' | 'notice';
  readonly body: string;
  readonly formattedBody: string | null;
  readonly mentions: {
    readonly userIds: readonly string[];
    readonly room: boolean;
  };
}

export type OutgoingMessage =
  | ({ readonly kind: 'text' } & OutgoingText)
  | {
      readonly kind: 'location';
      readonly lat: number;
      readonly lng: number;
      readonly label: string | null;
    }
  | {
      readonly kind: 'sticker';
      readonly body: string;
      readonly url: string;
      readonly info: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'poll-start';
      readonly question: string;
      readonly answers: readonly string[];
      readonly maxSelections: number;
    }
  | {
      readonly kind: 'poll-response';
      readonly pollId: string;
      readonly answerIds: readonly string[];
    }
  | { readonly kind: 'poll-end'; readonly pollId: string };

export interface VoiceClip {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly waveform: readonly number[];
}

export interface Profile {
  readonly displayName: string | null;
  /** Another member shares the name, so it is shown with the user id. */
  readonly displayNameAmbiguous: boolean;
  readonly avatarMxc: string | null;
}

export interface ShieldCode {
  readonly colour: 'red' | 'grey';
  readonly reason:
    | 'unverified-identity'
    | 'unsigned-device'
    | 'unknown-device'
    | 'authenticity-not-guaranteed'
    | 'verification-violation'
    | 'mismatched-sender'
    | 'unknown';
}

export type SendState =
  | { readonly kind: 'sending' }
  /** Failed while offline; resends on reconnect. */
  | { readonly kind: 'waiting' }
  | { readonly kind: 'failed'; readonly recoverable: boolean };

export interface ReactionGroup {
  readonly key: string;
  readonly count: number;
  readonly reactedByMe: boolean;
  /** Earliest first, at most `MAX_NAMED_REACTORS`; the full list comes from `reactionDetails`. */
  readonly senders: readonly string[];
}

export interface ReactionDetailGroup {
  readonly key: string;
  readonly senders: readonly string[];
  readonly profiles: Readonly<Record<string, Profile>>;
}

export interface InReplyTo {
  readonly eventId: string;
  readonly details:
    | { readonly kind: 'pending' | 'unavailable' }
    | {
        readonly kind: 'ready';
        readonly sender: string;
        readonly body: string;
        readonly redacted: boolean;
        readonly unencryptedMark: UnencryptedMark | null;
      };
}

/** {@link NormalizedSystemChange} naming users by id; names come from the item's profiles. */
export type SystemChange = WithActorId<NormalizedSystemChange>;

type WithActorId<Change> = Change extends unknown
  ? Omit<Change, 'actorName' | 'targetName'> & { readonly actorId: string }
  : never;

export type TimelineItemContent =
  | {
      readonly kind: 'message';
      readonly msgtype: 'text' | 'emote' | 'notice';
      readonly body: string;
      readonly formattedBody: string | null;
      readonly replyFallback: boolean;
      readonly mentionsMe: boolean;
      readonly mentions: readonly string[];
    }
  | {
      readonly kind: 'media';
      readonly msgtype: 'image' | 'file' | 'video' | 'audio';
      readonly source: MediaPayload;
      readonly body: string;
      readonly caption: string | null;
      readonly formattedCaption: string | null;
      readonly replyFallback: boolean;
      readonly mentionsMe: boolean;
      readonly mentions: readonly string[];
    }
  | {
      readonly kind: 'sticker';
      readonly source: MediaPayload;
      /** The raw `content.body`, `url` and `info`, so a sticker can be added to a pack. */
      readonly body: string | null;
      readonly url: string | null;
      readonly info: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly kind: 'location';
      readonly lat: number;
      readonly lng: number;
      readonly label: string;
    }
  | { readonly kind: 'poll'; readonly poll: PollView }
  | { readonly kind: 'redacted'; readonly replyFallback: boolean }
  | {
      readonly kind: 'unableToDecrypt';
      readonly reason: UndecryptableReason | null;
      readonly replyFallback: boolean;
    }
  | {
      readonly kind: 'unsupported';
      readonly body: string;
      readonly replyFallback: boolean;
    }
  | { readonly kind: 'state'; readonly change: SystemChange };

export interface EventTimelineItem {
  readonly kind: 'event';
  /** Stable from local echo to remote echo. */
  readonly uniqueId: string;
  readonly eventId: string | null;
  readonly transactionId: string | null;
  readonly sender: string;
  readonly isOwn: boolean;
  readonly timestamp: number;
  readonly sendState: SendState | null;
  readonly content: TimelineItemContent;
  readonly edited: boolean;
  readonly inReplyTo: InReplyTo | null;
  readonly reactions: readonly ReactionGroup[];
  /** Readers whose receipt sits here, minus self and the sender, capped. */
  readonly readBy: readonly string[];
  /** `null` for no shield, or one not resolved yet. */
  readonly shield: ShieldCode | null;
  readonly unencryptedMark: UnencryptedMark | null;
  /** Every user the item names: sender, quoted sender, reactors, readers, mentions, actor, target. */
  readonly profiles: Readonly<Record<string, Profile>>;
}

/** Date dividers are not items: the feature side owns local days. */
export type VirtualTimelineItem =
  | { readonly kind: 'readMarker'; readonly uniqueId: string }
  | { readonly kind: 'timelineStart'; readonly uniqueId: string };

export type TimelineItem = EventTimelineItem | VirtualTimelineItem;

export interface TimelineRoomState {
  readonly encryption: 'encrypted' | 'unencrypted' | 'unknown';
  /** Whether the room state holds `m.room.encryption`; unlike `encryption`, the crypto store does not count. */
  readonly hasEncryptionStateEvent: boolean;
  readonly tombstone: {
    readonly replacementRoomId: string;
    readonly body: string;
  } | null;
  /** Newest confirmed event, hidden ones included: what a read receipt acknowledges. */
  readonly latestConfirmedEventId: string | null;
  readonly oldestEventId: string | null;
}

export type TimelineUpdate =
  /** The account does not hold the room yet; the stream emits again when it does. */
  | { readonly kind: 'room-unavailable' }
  | {
      readonly kind: 'items';
      readonly diffs: readonly VectorDiff<TimelineItem>[];
      readonly backPagination: 'idle' | 'paginating' | 'start-reached';
      readonly room: TimelineRoomState;
    };

/**
 * Commands reply only after their effect is in every open `timeline()` subscription. A send's
 * local echo is in `timeline()` before `send` replies, and its item keeps its `uniqueId` when
 * the remote echo replaces it.
 */
export interface TimelineEngine {
  /** Emits a full snapshot first. The js-sdk adapter emits synchronously on subscribe; other engines may not. */
  timeline(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
  ): Observable<TimelineUpdate>;

  /**
   * Starting emits `{ diffs: [], backPagination: 'paginating' }`. The page's diffs and the
   * next `backPagination` state arrive in one update, and the reply follows it.
   */
  paginateBackwards(
    accountId: string,
    roomId: string,
    focus: TimelineFocus,
    count: number,
  ): Observable<EngineResult<{ readonly startReached: boolean }>>;

  /** Pages the live timeline back until `eventId` is loaded, at most `maxPages` times. */
  paginateUntil(
    accountId: string,
    roomId: string,
    eventId: string,
    maxPages: number,
  ): Observable<EngineResult<{ readonly found: boolean }>>;

  /** `null` when the room has no event then; `unsupported` when the server cannot look it up. */
  eventAt(
    accountId: string,
    roomId: string,
    timestamp: number,
  ): Observable<EngineResult<{ readonly eventId: string } | null>>;

  /** The effective (decrypted) event. */
  eventSource(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<Readonly<Record<string, unknown>> | null>>;

  reactionDetails(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<readonly ReactionDetailGroup[]>>;

  sendReceipt(
    accountId: string,
    roomId: string,
    eventId: string,
    options: {
      readonly threadRootId: string | null;
      readonly visibility: 'public' | 'private';
      readonly fullyRead: boolean;
    },
  ): Observable<EngineResult<null>>;

  setTyping(
    accountId: string,
    roomId: string,
    typing: boolean,
  ): Observable<EngineResult<null>>;

  /**
   * Sends `message`, in the thread `threadRootId` when set. `replyTo` quotes that event, fetched
   * from the server when it is not loaded; only text replies. `eventId` is null when the send
   * failed and its echo stays, with its `sendState`, for `retrySend` or `cancelSend`.
   * `transactionId`, when given, is the echo's, so the caller can cancel this send before
   * it returns; it must be unique to the account.
   */
  send(
    accountId: string,
    roomId: string,
    message: OutgoingMessage,
    options: {
      readonly threadRootId: string | null;
      readonly replyTo: string | null;
      readonly transactionId?: string;
    },
  ): Observable<
    EngineResult<{
      readonly transactionId: string;
      readonly eventId: string | null;
    }>
  >;

  /** Replaces the text of `item`, which must be the account's own. */
  edit(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    message: OutgoingText,
    options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>>;

  /** Authorization is the caller's: the server is the judge. */
  redact(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>>;

  /** Removes every reaction of the account with `key` on `item`, or adds one when it has none. */
  toggleReaction(
    accountId: string,
    roomId: string,
    item: TimelineItemKey,
    key: string,
    options: { readonly threadRootId: string | null },
  ): Observable<EngineResult<null>>;

  /** `message-unavailable` when no unsent echo has `transactionId`. */
  retrySend(
    accountId: string,
    roomId: string,
    transactionId: string,
  ): Observable<EngineResult<null>>;

  /** `not-cancellable` once the request may have left the device. */
  cancelSend(
    accountId: string,
    roomId: string,
    transactionId: string,
  ): Observable<EngineResult<null>>;

  /**
   * Sends a copy of the message as the account's own, with no relation and no mentions.
   * `not-forwardable` for a type it cannot copy faithfully, a redacted message included.
   */
  forward(
    accountId: string,
    sourceRoomId: string,
    eventId: string,
    targetRoomId: string,
  ): Observable<EngineResult<null>>;

  /**
   * Uploads the clip, encrypted in an encrypted room, and sends it as an `m.audio` voice
   * message. `encryption-unavailable` when the room is encrypted and the account has no crypto.
   */
  sendVoice(
    accountId: string,
    roomId: string,
    clip: VoiceClip,
  ): Observable<EngineResult<null>>;
}
