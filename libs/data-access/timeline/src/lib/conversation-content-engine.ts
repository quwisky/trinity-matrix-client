import type { Observable } from 'rxjs';
import type { EngineResult, UnencryptedMark } from '@trinity/util/matrix';
import type { Profile, ShieldCode } from './timeline-engine';

/** One pinned event. Unless `loaded`, `sender` and `body` are empty and `ts` is 0. */
export interface PinnedEntry {
  readonly eventId: string;
  /**
   * `loading` while an event outside the loaded timeline is fetched; `unavailable` when the
   * server will not return it; `failed` when fetching it failed, retried later.
   */
  readonly status: 'loaded' | 'loading' | 'unavailable' | 'failed';
  readonly sender: string;
  /** A one-line preview of the message. */
  readonly body: string;
  readonly ts: number;
  readonly shield: ShieldCode | null;
  readonly unencryptedMark: UnencryptedMark | null;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export interface PinnedEvents {
  /** The newest pinned ids, oldest first; non-string entries of the room's list are left out. */
  readonly eventIds: readonly string[];
  /** Every string id of the room's list, oldest first, older ones beyond `eventIds` included. */
  readonly allEventIds: readonly string[];
  /** One per id, in order, except redacted events. */
  readonly entries: readonly PinnedEntry[];
}

export interface SearchHit {
  readonly eventId: string;
  readonly sender: string;
  readonly body: string;
  readonly ts: number;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export interface Revision {
  readonly eventId: string;
  readonly sender: string;
  readonly ts: number;
  /** `undecryptable` carries an empty `body` and no `html`. */
  readonly kind: 'text' | 'undecryptable';
  readonly body: string;
  /** The version's unsanitised `formatted_body`, or null when it has no HTML. */
  readonly html: string | null;
  readonly shield: ShieldCode | null;
  /** Judged on this version's own encryption, not the message's latest edit. */
  readonly unencryptedMark: UnencryptedMark | null;
  /** The sender and every user the HTML links to. */
  readonly profiles: Readonly<Record<string, Profile>>;
}

export interface LinkPreview {
  readonly title: string | null;
  readonly description: string | null;
  readonly imageMxc: string | null;
}

/**
 * Conversation content read on demand: pins, search, edit history and link previews.
 * Separate from {@link TimelineEngine}, which stays shaped like matrix-sdk-ui's `Timeline`.
 */
export interface ConversationContentEngine {
  /** Emits a full state first, and again whenever the pins or their events change. */
  pinnedEvents(accountId: string, roomId: string): Observable<PinnedEvents>;

  /** Replies once the new list is in every open `pinnedEvents` subscription. */
  pin(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>>;

  /** Replies once the new list is in every open `pinnedEvents` subscription. */
  unpin(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>>;

  /**
   * Re-fetches the pins whose fetch failed in every open `pinnedEvents` subscription for
   * the room; replies at once, and the results arrive through those subscriptions.
   */
  retryFailedPins(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<null>>;

  /** `{ encrypted: true }`, without a request, when the room counts as encrypted. */
  searchMessages(
    accountId: string,
    roomId: string,
    term: string,
    nextBatch: string | null,
  ): Observable<
    EngineResult<
      | {
          readonly hits: readonly SearchHit[];
          readonly count: number;
          readonly nextBatch: string | null;
        }
      | { readonly encrypted: true }
    >
  >;

  /**
   * The original, then each edit, oldest first; empty when the message was deleted.
   * `truncated` when more than `maxPages` pages (at most 10) of edits exist.
   */
  editHistory(
    accountId: string,
    roomId: string,
    eventId: string,
    options: { readonly maxPages: number },
  ): Observable<
    EngineResult<{
      readonly revisions: readonly Revision[];
      readonly truncated: boolean;
    }>
  >;

  /** Redacts the `m.replace` event that introduced one version of a message. */
  removeRevision(
    accountId: string,
    roomId: string,
    revisionEventId: string,
  ): Observable<EngineResult<null>>;

  /**
   * `null` when the page has nothing to show, or, without a request, when
   * `onlyIfUnencrypted` names a room not confirmed unencrypted. `unsupported` when the
   * homeserver has no preview endpoint.
   */
  linkPreview(
    accountId: string,
    url: string,
    options: { readonly onlyIfUnencrypted: string | null },
  ): Observable<EngineResult<LinkPreview | null>>;
}
