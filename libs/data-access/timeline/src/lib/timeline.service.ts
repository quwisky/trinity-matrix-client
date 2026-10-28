import {
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  Observable,
  Subject,
  defaultIfEmpty,
  defer,
  finalize,
  map,
  of,
  switchMap,
  takeUntil,
  type Subscription,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { SystemLineSettingsService } from '@trinity/platform-native';
import {
  TYPING_REFRESH_MS,
  initialOf,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import {
  ConversationTimelineReadiness,
  READY_LOAD_STATE,
} from './conversation-timeline-readiness';
import type { TrimGuard } from './live-timeline-trim';
import { CONVERSATION_ATTENTION } from './conversation-attention.port';
import type { ConversationKey } from './conversation-messages';
import {
  CONVERSATION_TYPING,
  type ConversationTypist,
} from './conversation-typing.port';
import type {
  MessageView,
  ReactionDetail,
  SystemLineCategory,
} from './message-presentation';
import {
  CONVERSATION_MESSAGE_ADAPTER,
  CONVERSATION_MESSAGE_POLICY,
} from './conversation-message-adapter.service';
import type { TimelineFocus } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { profileName } from './timeline-item-presentation';
import { type TimelineStore, TimelineStores } from './timeline-store';
import { onWindowFocus, windowHasFocus } from './window-focus';

const SCROLLBACK = 30;
const RETAINED_EVENT_BYTES = 64;
const RETAINED_SENDER_BYTES = 16;
const LIVE: TimelineFocus = { kind: 'live' };
const NO_MESSAGES: readonly MessageView[] = [];

/**
 * Outcome of a "jump to date" attempt. A union rather than `string | null`: the outcomes
 * need different things said to the user and are not failures of one kind.
 */
export type JumpToDateResult =
  /** The event is loaded and can be scrolled to. */
  | { kind: 'found'; eventId: string }
  /** Reachable in principle, but further back than the bounded scrollback goes. */
  | { kind: 'too-far' }
  /** The room has nothing at or after that date (a date before it existed, or the future). */
  | { kind: 'no-event' }
  /** The homeserver does not implement MSC3030 at all. */
  | { kind: 'unsupported' }
  /** The request itself did not complete — offline, rate-limited, refused, timed out. */
  | { kind: 'failed' };

/**
 * Max pages a date jump spends: 20 x 30 events is roughly the history people scroll to by
 * hand, and it bounds the worst case at 20 sequential requests.
 */
const MAX_JUMP_PAGES = 20;

/** The open room's tombstone: it was replaced by a successor room (`m.room.tombstone`). */
export interface RoomTombstone {
  /** The successor room id to move to. */
  replacementRoomId: string;
  /** The upgrade message (e.g. "This room has been replaced"), if any. */
  body: string;
}

/**
 * Which composer a typing report came from. `m.typing` is one flag per room, so the stop
 * is sent only when every surface has gone quiet.
 */
export type TypingOwner = 'room' | 'thread';

/**
 * One Conversation child's main timeline, read from its {@link TimelineStore}: the rows, the
 * paging state and the room facts the views need. Typing, read receipts and paging go to the
 * timeline engine for the Conversation's frozen Account-and-Room key.
 *
 * Conversation Runtime creates this package-internal child for one key, opens it once, and
 * owns its blur/retain/retire lifetime. A blurred child keeps its store but suppresses
 * foreground effects; retirement calls `close()` and destroys its child injector.
 */
@Injectable()
export class TimelineService {
  private readonly engine = inject(TIMELINE_ENGINE);
  private readonly stores = inject(TimelineStores);
  private readonly session = inject(SessionStateService);
  private readonly typingPort = inject(CONVERSATION_TYPING);
  private readonly systemLines = inject(SystemLineSettingsService);
  private readonly messageAdapter = inject(CONVERSATION_MESSAGE_ADAPTER);
  private readonly messagePolicy = inject(CONVERSATION_MESSAGE_POLICY);
  private readonly readiness = inject(ConversationTimelineReadiness, {
    optional: true,
  });
  private readonly attention = inject(CONVERSATION_ATTENTION, {
    optional: true,
  });

  private readonly store = signal<TimelineStore | null>(null);
  private readonly typists = signal<Signal<
    readonly ConversationTypist[]
  > | null>(null);
  private readonly visible = signal(true);
  private storeUpdates: Subscription | null = null;
  /** Emits on close: paging for a room nobody is looking at stops after its page in flight. */
  private readonly closing = new Subject<void>();

  // Time (ms) of the last typing start, so the flag is refreshed at most every
  // TYPING_REFRESH_MS rather than per keystroke; 0 means not marked as typing.
  private typingSentAt = 0;

  /**
   * Which composers currently hold text. `m.typing` is one flag per room, fed by both the
   * timeline composer and the thread panel's; the stop goes out when the LAST owner goes
   * quiet.
   */
  private readonly typingOwners = new Set<TypingOwner>();

  /**
   * The oldest event the room's view shows while it follows the newest message, or null
   * while scrolled back or unreported. See {@link setLiveView}.
   */
  private liveViewFrom: string | null = null;

  // Latest event already read-receipted, so live messages mark read without re-sending on
  // every update and pagination (latest unchanged) doesn't re-ack.
  private lastReadEventId: string | null = null;
  private readReceiptInFlightId: string | null = null;
  private readReceiptSubscription: Subscription | null = null;

  /** The window regained focus: send the read receipt held back while unfocused. */
  private readonly onFocus = (): void => this.markRead();
  private stopFocusListener: (() => void) | null = null;

  /** The Conversation's loading interval; ready when no runtime owns this projection. */
  readonly loadState = computed(
    () => this.readiness?.state() ?? READY_LOAD_STATE,
  );

  /** The rows, minus the system-line categories the user switched off. */
  readonly messages: Signal<readonly MessageView[]> = computed(() => {
    const all = this.store()?.messages() ?? NO_MESSAGES;
    const shown = {
      membership: this.systemLines.showMembership(),
      profile: this.systemLines.showProfile(),
      room: this.systemLines.showRoomChanges(),
    } satisfies Record<SystemLineCategory, boolean>;
    return all.filter(
      (view) => !view.systemCategory || shown[view.systemCategory],
    );
  });

  /** Whether the open room is in the engine's view of its Account. */
  readonly available = computed(() => !!this.store()?.available());

  readonly loadingOlder = computed(
    () => this.store()?.backPagination() === 'paginating',
  );

  readonly canLoadOlder = computed(() => {
    const store = this.store();
    return !!store?.available() && store.backPagination() !== 'start-reached';
  });

  /**
   * Id of the OLDEST event in the loaded window, including ones the projection drops
   * (hidden system lines, edits, reactions). The message lists need it because the oldest
   * *rendered* row can't show whether a backfill pulled in history.
   */
  readonly oldestEventId = computed(
    () => this.store()?.room()?.oldestEventId ?? null,
  );

  /** Display names of the *other* members typing in the open room. */
  readonly typingNames = computed(() =>
    this.visible()
      ? (this.typists()?.() ?? []).map((typist) => typist.displayName)
      : [],
  );

  // Whether the user's power level lets them redact OTHER users' messages; re-read on every
  // timeline update, which a power-levels change causes. The homeserver stays the authority.
  readonly canRedactOthers = computed(() => {
    const store = this.store();
    if (!store?.available()) return false;
    store.items();
    return this.messagePolicy.canRedactOthers(store.key);
  });

  // Sending defaults to allowed when unknown so a missing room never blocks the composer.
  readonly canSendMessages = computed(() => {
    const store = this.store();
    if (!store?.available()) return true;
    store.items();
    return this.messagePolicy.canSendMessages(store.key);
  });

  /** The open room's tombstone, or null; drives the banner linking to the successor room. */
  readonly tombstone = computed<RoomTombstone | null>(
    () => this.store()?.room()?.tombstone ?? null,
    {
      equal: (a, b) =>
        (a?.replacementRoomId ?? null) === (b?.replacementRoomId ?? null),
    },
  );

  /**
   * Event id of the first unread message: the first after the read marker as it stood when
   * the room opened that isn't the user's own. Drives the "New messages" divider and
   * jump-to-unread.
   */
  readonly firstUnreadId = computed(
    () => this.store()?.firstUnreadId() ?? null,
  );

  constructor() {
    // A create that fails after open() destroys the injector without retiring this child.
    inject(DestroyRef).onDestroy(() => this.close());
    // App lock released: the person is looking again, so ack what arrived behind the cover.
    // markRead still holds it until the window has focus and the conversation is visible.
    effect(() => {
      if (this.attention?.attentive()) untracked(() => this.markRead());
    });
  }

  /** Re-run the failed loading step. */
  retryLoad(): void {
    this.readiness?.retry();
  }

  /** The open room's id, or null. */
  get openRoomId(): string | null {
    return this.store()?.key.roomId ?? null;
  }

  /** Whether the visible room counts as encrypted: its state, or else its crypto store. */
  get roomEncrypted(): boolean {
    return this.visible() && this.store()?.room()?.encryption === 'encrypted';
  }

  /** Start showing one Account's room; a no-op when that room is already open. */
  open(key: ConversationKey): void {
    const current = this.store()?.key;
    if (current?.accountId === key.accountId && current.roomId === key.roomId) {
      return;
    }
    this.close();
    this.visible.set(true);
    const store = this.stores.open(key, LIVE);
    this.store.set(store);
    this.typists.set(this.typingPort.typing(key.accountId, key.roomId));
    // Live messages re-ack through the same path (see markRead).
    this.storeUpdates = store.updates.subscribe(() => this.markRead());
    // While unfocused markRead holds the receipt so unread accrues; mark read again on refocus.
    this.stopFocusListener = onWindowFocus(this.onFocus);
    this.markRead();
  }

  /**
   * Say where the room's view is: following the newest message and showing everything from
   * `oldestShownId` on, or scrolled back (`null`). While the window is hidden, the focused
   * room is trimmed only while its view follows the newest message, and never past what it
   * shows. A hidden (blurred) Conversation has no view.
   */
  setLiveView(oldestShownId: string | null): void {
    this.liveViewFrom = this.visible() ? oldestShownId : null;
  }

  /**
   * What a trim of this room must keep so its view looks the same afterwards, or null when
   * it must not be trimmed: the view is scrolled back, older history is being paged in, or
   * the view shows events the timeline does not hold. Keeps what the view shows and,
   * like the read receipt, the messages its rows quote and the event the "New messages"
   * divider was drawn against.
   */
  liveTrimGuard(): TrimGuard | null {
    const from = this.liveViewFrom;
    const store = this.store();
    if (!this.visible() || !store || !from || this.loadingOlder()) return null;
    const items = store.items();
    const start = items.findIndex(
      (item) => item.kind === 'event' && item.eventId === from,
    );
    if (start === -1) return null;
    const quoted = items
      .slice(start)
      .flatMap((item) =>
        item.kind === 'event' && item.inReplyTo ? [item.inReplyTo.eventId] : [],
      );
    return { marked: [store.unreadAnchorEventId(), ...quoted], kept: [from] };
  }

  /** Toggle foreground-only effects; the store stays subscribed. */
  setVisible(visible: boolean): void {
    if (this.visible() === visible) return;
    this.visible.set(visible);
    // A view reports again once it shows this Conversation.
    this.liveViewFrom = null;
    if (!visible) this.stopTyping();
    // Hidden, the store presents only the newest rows; shown, the whole loaded window.
    this.store()?.setVisible(visible);
    this.markRead();
  }

  /** Deterministic diagnostics for the bounded Conversation Runtime retention policy. */
  resources(): {
    readonly listenerCount: number;
    readonly retainedBytes: number;
  } {
    const store = this.store();
    if (!store?.available()) {
      return { listenerCount: 0, retainedBytes: 0 };
    }
    const messages = untracked(store.messages);
    const senders = new Set(messages.map((message) => message.senderId));
    return {
      listenerCount: 11 + (typeof window === 'undefined' ? 0 : 1),
      retainedBytes:
        messages.length * RETAINED_EVENT_BYTES +
        senders.size * RETAINED_SENDER_BYTES,
    };
  }

  /** Stop showing the room and close its store. */
  close(): void {
    this.closing.next();
    this.readReceiptSubscription?.unsubscribe();
    this.readReceiptSubscription = null;
    this.readReceiptInFlightId = null;
    this.stopTyping();
    this.stopFocusListener?.();
    this.stopFocusListener = null;
    this.storeUpdates?.unsubscribe();
    this.storeUpdates = null;
    this.store()?.close();
    this.store.set(null);
    this.typists.set(null);
    this.lastReadEventId = null;
    this.liveViewFrom = null;
  }

  /** Page in older history. */
  loadOlder(): Observable<void> {
    return defer(() => {
      const store = this.shownStore();
      if (!store || this.loadingOlder()) return of(void 0);
      const { accountId, roomId } = store.key;
      return this.engine
        .paginateBackwards(accountId, roomId, LIVE, SCROLLBACK)
        .pipe(
          unwrapEngineResult(),
          map(() => void 0),
        );
    });
  }

  /**
   * Page the room back in after its live timeline was rewound to empty: to about `depth`
   * events while the Conversation is shown, at least one page; one page while it is
   * retained. Starts once any paging already running ends, as the engine queues a room's
   * pages; unsubscribing stops it after the page in flight. Cold.
   */
  refill(depth: number): Observable<void> {
    return defer(() => {
      const store = this.store();
      if (!store) return of(void 0);
      const { accountId, roomId } = store.key;
      const target = this.visible() ? depth : 1;
      const loaded = (): number =>
        store.items().filter((item) => item.kind === 'event').length;
      const page = (count: number): Observable<void> =>
        this.engine.paginateBackwards(accountId, roomId, LIVE, SCROLLBACK).pipe(
          unwrapEngineResult(),
          switchMap(({ startReached }) =>
            startReached || loaded() >= target || count >= MAX_JUMP_PAGES
              ? of(void 0)
              : page(count + 1),
          ),
        );
      return page(1).pipe(this.untilClosed<void>(undefined));
    });
  }

  /**
   * Page history back until `eventId` is loaded, so a jump to a pinned or searched message
   * that was never loaded has an element to scroll to. Emits whether it is now loaded;
   * bounded by {@link MAX_JUMP_PAGES}, like a date jump. Cold.
   */
  loadEvent(eventId: string): Observable<boolean> {
    return defer(() => {
      const store = this.shownStore();
      if (!store) return of(false);
      const { accountId, roomId } = store.key;
      return this.engine
        .paginateUntil(accountId, roomId, eventId, MAX_JUMP_PAGES)
        .pipe(
          unwrapEngineResult(),
          map(({ found }) => found),
          this.untilClosed(false),
        );
    });
  }

  /**
   * Find the first message on or after `dayStartMs` and page history back until it is
   * loaded, so the caller can scroll to it. Cold; runs on subscribe.
   *
   * The server's answer (MSC3030) is for the WHOLE room, so it can name an event far back
   * that this client has never seen; scrolling to an id the DOM lacks silently does
   * nothing, hence the paging. Paging extends the live timeline rather than opening one at
   * the target, so only dates within {@link MAX_JUMP_PAGES} pages are reached; anything
   * further reports `too-far`.
   *
   * The server's event id is a POSITION, not a target: the first event of a day is often a
   * reaction, an edit or a hidden membership line. So the target is the first RENDERED
   * message at or after the requested midnight.
   */
  jumpToDate(dayStartMs: number): Observable<JumpToDateResult> {
    return defer(() => {
      const store = this.shownStore();
      if (!store) return of<JumpToDateResult>({ kind: 'no-event' });
      const { accountId, roomId } = store.key;
      return this.engine.eventAt(accountId, roomId, dayStartMs).pipe(
        switchMap((at): Observable<JumpToDateResult> => {
          if (!at.ok) {
            return of({
              kind:
                at.failure.code === 'unsupported' ? 'unsupported' : 'failed',
            });
          }
          if (!at.value) return of({ kind: 'no-event' });
          return this.engine
            .paginateUntil(accountId, roomId, at.value.eventId, MAX_JUMP_PAGES)
            .pipe(
              map((paged): JumpToDateResult => {
                if (!paged.ok) return { kind: 'failed' };
                return paged.value.found
                  ? this.renderableFrom(dayStartMs)
                  : { kind: 'too-far' };
              }),
            );
        }),
        this.untilClosed<JumpToDateResult>({ kind: 'too-far' }),
      );
    });
  }

  /**
   * The first projected message at or after `dayStartMs`, or `no-event` when nothing from
   * then on renders. `messages()` is in timeline order.
   */
  private renderableFrom(dayStartMs: number): JumpToDateResult {
    const target = this.messages().find((m) => m.timestamp >= dayStartMs);
    return target
      ? { kind: 'found', eventId: target.id }
      : { kind: 'no-event' };
  }

  /** Ends `source` with `fallback` when the room closes first. */
  private untilClosed<T>(
    fallback: T,
  ): (source: Observable<T>) => Observable<T> {
    return (source) =>
      source.pipe(takeUntil(this.closing), defaultIfEmpty(fallback));
  }

  /** The store while the Conversation is shown and its room is available, else null. */
  private shownStore(): TimelineStore | null {
    const store = this.store();
    return this.visible() && store?.available() ? store : null;
  }

  /**
   * Broadcast whether the local user is typing in the open room; fire-and-forget. Starts
   * are throttled to one per TYPING_REFRESH_MS; the server keeps the flag alive for
   * TYPING_TIMEOUT_MS, so it never lapses mid-compose. A no-op when no room is shown.
   */
  setTyping(typing: boolean, owner: TypingOwner = 'room'): void {
    const store = this.shownStore();
    if (!store) return;
    if (typing) {
      this.typingOwners.add(owner);
    } else {
      this.typingOwners.delete(owner);
      // Another composer still holds a draft: the stop would mark us not typing while its
      // text sits there, and nothing re-announces until the next keystroke.
      if (this.typingOwners.size) return;
    }
    const now = Date.now();
    if (typing) {
      if (this.typingSentAt && now - this.typingSentAt < TYPING_REFRESH_MS) {
        return;
      }
      this.typingSentAt = now;
    } else {
      if (!this.typingSentAt) return;
      this.typingSentAt = 0;
    }
    this.sendTyping(store.key, typing);
  }

  /**
   * Clears local typing ownership, and sends the stop on this Conversation's own Account
   * when it had started typing and is still signed in: after a sign-out the token is
   * revoked and nobody is left to report to.
   */
  private stopTyping(): void {
    const key = this.store()?.key;
    const hadSentTyping = this.typingSentAt !== 0;
    this.typingSentAt = 0;
    this.typingOwners.clear();
    if (!key || !hadSentTyping || !this.signedIn(key.accountId)) return;
    this.sendTyping(key, false);
  }

  private sendTyping(key: ConversationKey, typing: boolean): void {
    this.engine.setTyping(key.accountId, key.roomId, typing).subscribe();
  }

  private signedIn(accountId: string): boolean {
    return untracked(this.session.snapshot).accounts.some(
      (account) => account.accountId === accountId,
    );
  }

  /**
   * The effective (decrypted) JSON of an event in the open room for "view source", or null
   * when it cannot be read. Cold.
   */
  eventSource(
    eventId: string,
  ): Observable<Readonly<Record<string, unknown>> | null> {
    return defer(() => {
      const key = this.store()?.key;
      if (!key) return of(null);
      return this.engine
        .eventSource(key.accountId, key.roomId, eventId)
        .pipe(map((result) => (result.ok ? result.value : null)));
    });
  }

  /**
   * Everyone who reacted to `eventId`, grouped by reaction key: the full list behind the
   * pills' capped hint. Thread rows work too. Empty when the room isn't shown or the event
   * isn't loaded; a snapshot, not a live list. Cold.
   */
  reactionDetails(eventId: string): Observable<readonly ReactionDetail[]> {
    return defer(() => {
      const key = this.shownStore()?.key;
      if (!key) return of([]);
      return this.engine
        .reactionDetails(key.accountId, key.roomId, eventId)
        .pipe(
          map((result) =>
            result.ok
              ? result.value.map((group): ReactionDetail => ({
                  key: group.key,
                  reacted: group.senders.includes(key.accountId),
                  reactors: group.senders.map((userId) => {
                    const profile = group.profiles[userId];
                    const name = profileName(userId, profile);
                    return {
                      userId,
                      name,
                      initial: initialOf(name),
                      avatarMxc: profile?.avatarMxc ?? null,
                    };
                  }),
                }))
              : [],
          ),
        );
    });
  }

  /**
   * Send a read receipt for the room's latest *confirmed* event, but ONLY while the window
   * is focused, so an open room still accumulates unread like any other channel;
   * {@link onFocus} re-acks on return. Likewise while {@link CONVERSATION_ATTENTION} says
   * nobody is looking (App lock covers the app); the constructor's attention effect re-acks.
   * Deduped on the last-acked event id so an update that leaves it (decryption, pagination)
   * doesn't re-send.
   */
  private markRead(): void {
    const store = this.store();
    if (!this.visible() || !store || !untracked(store.available)) return;
    // Unfocused: hold the receipt so unread accumulates; onFocus re-acks on return.
    if (!windowHasFocus()) return;
    // Covered by App lock: focused, but nobody is looking; the attention effect re-acks.
    if (this.attention && !untracked(this.attention.attentive)) return;
    const id = untracked(store.room)?.latestConfirmedEventId ?? null;
    if (
      !id ||
      id === this.lastReadEventId ||
      id === this.readReceiptInFlightId
    ) {
      return;
    }
    const key = store.key;
    this.readReceiptSubscription?.unsubscribe();
    this.readReceiptInFlightId = id;
    const subscription = this.messageAdapter
      .acknowledge({ key, messageId: id })
      .pipe(
        finalize(() => {
          if (this.readReceiptInFlightId === id) {
            this.readReceiptInFlightId = null;
            this.readReceiptSubscription = null;
          }
        }),
      )
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'applied' && this.store() === store) {
            this.lastReadEventId = id;
          }
        },
        error: () => undefined,
      });
    this.readReceiptSubscription = subscription.closed ? null : subscription;
  }
}
