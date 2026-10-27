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

/** A local echo has a transaction id only until its remote echo. */
export interface TimelineItemKey {
  readonly eventId: string | null;
  readonly transactionId: string | null;
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
      readonly body: string;
      /** The raw `content.url` and `content.info`, so a sticker can be added to a pack. */
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
 * Commands reply only after their effect is in every open `timeline()` subscription.
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
}
