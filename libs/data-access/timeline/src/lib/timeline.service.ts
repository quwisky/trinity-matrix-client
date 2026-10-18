import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  Direction,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import {
  Observable,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
  type Subscription,
} from 'rxjs';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';
import { MediaPipeline } from '@trinity/data-access/media';
import { SystemLineSettingsService } from '@trinity/platform-native';
import {
  collectMessageSenders,
  isDisplayableMessage,
  reactionDetailsFor,
  RoomEncryptionFlags,
  TYPING_REFRESH_MS,
  TYPING_TIMEOUT_MS,
  liveRoomState,
} from '@trinity/util/matrix';
import {
  ConversationTimelineReadiness,
  READY_LOAD_STATE,
} from './conversation-timeline-readiness';
import {
  resolveShieldsInto,
  shieldKey,
  shieldSubject,
  unencryptedShieldFor,
} from './shields';
import { projectMessage } from './project-message';
import { isPresentableSystemEvent } from './normalize-timeline-event';
import { scrollbackLive } from './live-scrollback';
import type { TrimGuard } from './live-timeline-trim';
import { CONVERSATION_ATTENTION } from './conversation-attention.port';
import type {
  MessageShield,
  MessageView,
  ReactionDetail,
  SystemLineCategory,
} from './message-presentation';
import {
  CONVERSATION_MESSAGE_ADAPTER,
  CONVERSATION_MESSAGE_POLICY,
} from './conversation-message-adapter.service';
import { onWindowFocus, windowHasFocus } from './window-focus';
import { TimelineRowCache } from './timeline-row-cache';
import { revisionOf } from './event-revision';

const SCROLLBACK = 30;
const RETAINED_EVENT_BYTES = 64;
const RETAINED_SHIELD_BYTES = 16;
const RETAINED_SENDER_BYTES = 16;
const RETAINED_EVENT_LIMIT = 100;
const RETAINED_SENDER_LIMIT = 200;

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
 * Max `scrollback` pages a date jump spends: 20 x 30 events is roughly the history people
 * scroll to by hand, and it bounds the worst case at 20 sequential requests.
 */
const MAX_JUMP_PAGES = 20;

/**
 * Map a rejection onto the outcome the UI should describe.
 *
 * Only two error codes mean something specific; everything else is a REQUEST failure, not
 * a fact about the room (a captive portal, or a 429 from this feature's own scrollback
 * burst, must not read as "no messages that day"). The caller's `catchError` also catches
 * backfill `scrollback` rejections, so the default must never claim anything about the
 * room's contents.
 */
function classifyJumpFailure(err: unknown): JumpToDateResult {
  const code = (err as { errcode?: string } | null)?.errcode;
  // M_UNRECOGNIZED is what a server that never heard of the endpoint returns; the SDK
  // surfaces a 404 on the route the same way.
  if (code === 'M_UNRECOGNIZED') {
    return { kind: 'unsupported' };
  }
  // M_NOT_FOUND is the endpoint working and reporting that the room has no such event.
  if (code === 'M_NOT_FOUND') {
    return { kind: 'no-event' };
  }
  return { kind: 'failed' };
}

/** The open room's tombstone: it was replaced by a successor room (`m.room.tombstone`). */
export interface RoomTombstone {
  /** The successor room id to move to. */
  replacementRoomId: string;
  /** The upgrade message (e.g. "This room has been replaced"), if any. */
  body: string;
}

/**
 * The room the timeline has open, with the client to act on it through. From
 * {@link TimelineService.openContext}, so `TimelineActionsService` resolves the open room
 * the way the projection does.
 */
export interface TimelineContext {
  client: MatrixClient;
  room: Room;
}

/**
 * Which composer a typing report came from. `m.typing` is one flag per room, so the stop
 * is sent only when every surface has gone quiet.
 */
export type TypingOwner = 'room' | 'thread';

/**
 * Projects one immutable Conversation child's live timeline into a `messages` signal of
 * view models; `matrix-js-sdk` remains the source of truth. Re-maps on new events and on
 * async E2EE decryption.
 *
 * With thread support enabled on the client (see {@link MatrixClientService}), the SDK
 * routes threaded replies into per-thread timelines, so only thread *roots* remain in the
 * main view; `ThreadsService` projects roots and replies separately.
 *
 * Not a `projectFromClient` projection: Conversation Runtime creates this package-internal
 * child for one frozen Account-and-Room key, opens it once with that Account's explicit
 * client, and owns its blur/retain/retire lifetime. A blurred child stays attached but
 * suppresses foreground effects; retirement calls `close()` and destroys its child
 * injector. Everything touching the client therefore addresses `connectedClient`, never
 * the mutable Active Account pointer. Only the shared `coalesce` is reused.
 */
@Injectable()
export class TimelineService {
  private readonly matrix = inject(MatrixClientService);
  private readonly systemLines = inject(SystemLineSettingsService);
  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly messageAdapter = inject(CONVERSATION_MESSAGE_ADAPTER);
  private readonly messagePolicy = inject(CONVERSATION_MESSAGE_POLICY);
  private readonly readiness = inject(ConversationTimelineReadiness, {
    optional: true,
  });
  private readonly attention = inject(CONVERSATION_ATTENTION, {
    optional: true,
  });

  /** The Conversation's loading interval; ready when no runtime owns this projection. */
  readonly loadState = computed(
    () => this.readiness?.state() ?? READY_LOAD_STATE,
  );

  /** Re-run the failed loading step. */
  retryLoad(): void {
    this.readiness?.retry();
  }

  private readonly _messages = signal<MessageView[]>([]);
  readonly messages = this._messages.asReadonly();

  private readonly _loadingOlder = signal(false);
  readonly loadingOlder = this._loadingOlder.asReadonly();

  private readonly _canLoadOlder = signal(false);
  readonly canLoadOlder = this._canLoadOlder.asReadonly();

  /**
   * Id of the OLDEST raw event in the loaded window, including ones the projection drops
   * (hidden system lines, edits, reactions). The message lists need it because the oldest
   * *rendered* row can't show whether a backfill pulled in history: a page of hidden events
   * would look like "nothing prepended" and stop the viewport-filling loop early.
   */
  private readonly _oldestEventId = signal<string | null>(null);
  readonly oldestEventId = this._oldestEventId.asReadonly();

  // Display names of the *other* members typing in the open room, from `m.typing`
  // (RoomMemberEvent.Typing); drives the "X is typing" row.
  private readonly _typingNames = signal<string[]>([]);
  readonly typingNames = this._typingNames.asReadonly();

  // Whether the user's power level lets them redact OTHER users' messages. Computed on open;
  // the homeserver is the authority, so a mid-session power change is picked up on the next
  // open and the server rejects a redaction we shouldn't have sent.
  private readonly _canRedactOthers = signal(false);
  readonly canRedactOthers = this._canRedactOthers.asReadonly();

  // The open room's tombstone, or null; drives the banner linking to the successor room.
  private readonly _tombstone = signal<RoomTombstone | null>(null);
  readonly tombstone = this._tombstone.asReadonly();

  // Time (ms) of the last `sendTyping(true)`, so the flag is refreshed at most every
  // {@link TYPING_REFRESH_MS} rather than per keystroke; 0 means not marked as typing.
  private typingSentAt = 0;

  /**
   * Which composers currently hold text. `m.typing` is one flag per room, fed by both the
   * timeline composer and the thread panel's; with a single flag, sending in the thread
   * cleared typing while the main composer still held a draft. The stop goes out when the
   * LAST owner goes quiet.
   */
  private readonly typingOwners = new Set<TypingOwner>();

  private roomId: string | null = null;
  private visible = true;

  /**
   * The oldest event the room's view shows while it follows the newest message, or null
   * while scrolled back or unreported. See {@link setLiveView}.
   */
  private liveViewFrom: string | null = null;

  /**
   * The client {@link open} attached its listeners to. `matrix.instance` follows the ACTIVE
   * account, so re-reading it in {@link close} after an account switch would detach from the
   * new client and leak every listener on the old, still-syncing one.
   */
  private connectedClient: MatrixClient | null = null;

  /**
   * Coalesce listener-driven re-projections into one per microtask.
   *
   * The SDK emits Timeline/Decrypted once **per event**, and {@link refresh} walks
   * every loaded event, so refreshing per event is quadratic in a burst (paginating 30
   * messages, decrypting a backfilled room). Under zoneless, refresh()'s signal writes
   * schedule change detection themselves, so typing and shield changes flush without an
   * incidental tick.
   *
   * Room-scoped, so it takes only the shared `coalesce` primitive; the `room` guard keeps
   * a queued pass from running against a closed room.
   */
  private readonly refreshCoalescer = coalesce(() => {
    if (this.room) {
      this.refresh();
    }
  });

  private scheduleRefresh(): void {
    this.refreshCoalescer.schedule();
  }

  constructor() {
    // Re-project when a system-line category is toggled: the filter runs during refresh. The
    // effect's first run only reads the signals, so it must not schedule a refresh.
    let seenInitial = false;
    effect(() => {
      this.systemLines.showMembership();
      this.systemLines.showProfile();
      this.systemLines.showRoomChanges();
      if (!seenInitial) {
        seenInitial = true;
        return;
      }
      this.scheduleRefresh();
    });
    // App lock released: the person is looking again, so ack what arrived behind the cover.
    // markRead still holds it until the window has focus and the conversation is visible.
    effect(() => {
      if (this.attention?.attentive()) untracked(() => this.markRead());
    });
  }

  /** Whether the user has this category of system line switched on. */
  private showsCategory(category: SystemLineCategory): boolean {
    switch (category) {
      case 'membership':
        return this.systemLines.showMembership();
      case 'profile':
        return this.systemLines.showProfile();
      case 'room':
        return this.systemLines.showRoomChanges();
    }
  }

  /** The open room's id, or null. Lets other services (e.g. NotificationService) tell
   * whether the user is viewing a room. */
  get openRoomId(): string | null {
    return this.roomId;
  }

  /** Whether the visible room declares the standard encrypted-room state event. */
  get roomEncrypted(): boolean {
    return this.visible && this.room?.hasEncryptionStateEvent() === true;
  }
  private room: Room | null = null;

  // Per-event projection cache by event id. Each row keeps its view and a fingerprint of
  // everything Message Presentation read (see {@link revisionOf}). A refresh re-checks only
  // the rows the listeners noted and re-projects one only when its fingerprint moved; the
  // others keep their view object, so their OnPush rows don't re-render.
  private readonly rows = new TimelineRowCache();

  /** The live timeline and encryption the rows were last projected against. */
  private projectedTimeline: EventTimeline | null = null;
  private projectedEncryption = '';

  // Latest event already read-receipted, so live messages mark read without re-sending on
  // every refresh and pagination/backfill (latest unchanged) doesn't re-ack.
  private lastReadEventId: string | null = null;
  private readReceiptInFlightId: string | null = null;
  private readReceiptSubscription: Subscription | null = null;

  // The persisted `m.fully_read` marker as of room open, captured once so the "New messages"
  // divider stays put while markRead advances the server-side marker. Null on a first visit
  // or when none is loaded.
  private readonly _readMarker = signal<string | null>(null);

  /**
   * Event id of the first unread message: the first after the on-open {@link _readMarker}
   * that isn't the user's own. Drives the "New messages" divider and jump-to-unread.
   *
   * Resolved in {@link refresh} against the RAW timeline order, not the projected list:
   * `markRead` acks the newest raw event, so `m.fully_read` can name an event the projection
   * never renders (hidden system line, reaction, edit, pin), and looking it up among the
   * rendered rows would silently drop the divider.
   */
  private readonly _firstUnreadId = signal<string | null>(null);
  readonly firstUnreadId = this._firstUnreadId.asReadonly();

  // Users the projection renders a member for (every sender plus every reply's quoted
  // sender). Recomputed each refresh so the member listener re-projects only for these, not
  // once per member of a lazy member-load.
  private relevantSenders = new Set<string>();

  // An event was added to (or removed from) a timeline of the room: paged in, received,
  // or a local echo. A removal re-checks every row, since what it took away may be quoted.
  private readonly onTimeline = (
    event?: MatrixEvent,
    _room?: Room,
    _toStartOfTimeline?: boolean,
    removed?: boolean,
  ): void => {
    if (removed) {
      this.rows.markAll();
    } else {
      this.rows.noteEvent(event);
    }
    this.scheduleRefresh();
  };
  private readonly onLocalEcho = (
    event?: MatrixEvent,
    _room?: Room,
    oldEventId?: string,
  ): void => {
    this.rows.noteEvent(event, oldEventId);
    this.scheduleRefresh();
  };
  // Others' read receipts moved — re-project so the "seen by" avatars follow them.
  private readonly onReceipt = (event?: MatrixEvent): void => {
    this.rows.noteReceipt(event);
    this.scheduleRefresh();
  };
  // A message, or a member's own events when they are banned with their messages (MSC4293),
  // lost its content. Received, local and cancelled redactions all land here or in onLocalEcho.
  private readonly onRedaction = (): void => {
    this.rows.markAll();
    this.scheduleRefresh();
  };
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.rows.noteEvent(event);
      this.scheduleRefresh();
    }
  };
  // Which edit a message resolves to can change with no new event (redacting an edit
  // re-aggregates onto an earlier revision). That is not a RoomEvent.Timeline signal, so
  // without this the row keeps showing the removed version.
  private readonly onReplaced = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.rows.noteEvent(event);
      this.scheduleRefresh();
    }
  };
  // A display name/avatar can arrive (lazy loading) or change after the events referencing
  // it, as a header sender or a reply preview's quoted sender (which would stay on the raw
  // mxid). The room re-emits Members for membership and profile changes; gate on
  // `relevantSenders` so only a referenced member re-maps.
  private readonly onMember = (
    _event: MatrixEvent,
    _state: RoomState,
    member: RoomMember,
  ): void => {
    if (
      member.roomId === this.roomId &&
      this.relevantSenders.has(member.userId)
    ) {
      this.rows.noteMember(member.userId);
      this.scheduleRefresh();
    }
  };

  // The event carries only the changed member; re-read the room's whole typing set so the
  // signal reflects everyone typing, not one delta.
  private readonly onTyping = (
    _event: MatrixEvent,
    member: RoomMember,
  ): void => {
    if (member.roomId === this.roomId) {
      this.refreshTyping();
    }
  };

  /** The window regained focus: send the read receipt held back while unfocused. */
  private readonly onFocus = (): void => this.markRead();
  private stopFocusListener: (() => void) | null = null;

  /**
   * Resolved authenticity shields per shield-subject id (a row's latest edit, else the
   * event itself; async, patched back via {@link refresh}).
   */
  private readonly shields = new Map<string, MessageShield | null>();

  /** Whether the open room counts as encrypted: its state, or else its crypto store. */
  private encryption = new RoomEncryptionFlags();

  // Cross-signing / device trust changed, so a shield may flip: force a full re-resolve,
  // bypassing the per-event skip a benign refresh uses.
  private readonly onTrust = (): void => {
    if (this.room) {
      void this.resolveShields(this.room, undefined, true);
    }
  };

  /** Start projecting a room on one fixed Account client; attaches live + decryption listeners. */
  open(roomId: string, accountClient?: MatrixClient): void {
    const client =
      accountClient ??
      (this.matrix.isInitialized ? this.matrix.instance : undefined);
    if (
      !client ||
      (this.roomId === roomId && this.connectedClient === client)
    ) {
      return;
    }
    this.close();
    this.visible = true;

    const room = client.getRoom(roomId);
    if (!room) {
      return;
    }

    this.roomId = roomId;
    this.room = room;
    this.connectedClient = client;
    room.on(RoomEvent.Timeline, this.onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, this.onLocalEcho);
    room.on(RoomEvent.Receipt, this.onReceipt);
    room.on(RoomEvent.Redaction, this.onRedaction);
    room.on(RoomStateEvent.Members, this.onMember);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    client.on(MatrixEventEvent.Replaced, this.onReplaced);
    client.on(RoomMemberEvent.Typing, this.onTyping);
    client.on(CryptoEvent.UserTrustStatusChanged, this.onTrust);
    client.on(CryptoEvent.DevicesUpdated, this.onTrust);
    client.on(CryptoEvent.KeysChanged, this.onTrust);
    // Members sync lazily, so the room knows only the senders seen so far; mentions, typing
    // names and sender profiles need everyone. They arrive as RoomState.members events,
    // which `onMember` re-projects.
    void room.loadMembersIfNeeded().catch(() => undefined);
    // Capture the persisted read marker BEFORE the first refresh (which marks read and
    // advances it), so the "New messages" divider anchors where the user left off.
    this._readMarker.set(this.readMarkerOf(room));
    this.updateRedactOthersPermission(room);
    // While unfocused markRead holds the receipt so unread accrues; mark read again on refocus.
    this.stopFocusListener = onWindowFocus(this.onFocus);
    // Projects the timeline and sends the initial read receipt; subsequent live
    // messages re-ack through the same path (see {@link markRead}).
    this.refresh();
  }

  /**
   * Say where the room's view is: following the newest message and showing everything from
   * `oldestShownId` on, or scrolled back (`null`). While the window is hidden, the focused
   * room is trimmed only while its view follows the newest message, and never past what it
   * shows. A hidden (blurred) Conversation has no view.
   */
  setLiveView(oldestShownId: string | null): void {
    this.liveViewFrom = this.visible ? oldestShownId : null;
  }

  /**
   * What a trim of this room must keep so its view looks the same afterwards, or null when
   * it must not be trimmed: the view is scrolled back, older history is being paged in, or
   * the view shows events the live timeline does not hold. Keeps what the view shows and,
   * like the read receipt, the messages its rows quote and the event the "New messages"
   * divider was drawn after.
   */
  liveTrimGuard(): TrimGuard | null {
    const from = this.liveViewFrom;
    const room = this.room;
    if (!this.visible || !room || !from || this._loadingOlder()) return null;
    const events = room.getLiveTimeline().getEvents();
    const start = events.findIndex((event) => event.getId() === from);
    if (start === -1) return null;
    const quoted = events
      .slice(start)
      .map((event) => event.replyEventId)
      .filter((eventId): eventId is string => !!eventId);
    return { marked: [this._readMarker(), ...quoted], kept: [from] };
  }

  /** Toggle foreground-only effects without detaching the warm timeline projection. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    // A view reports again once it shows this Conversation.
    this.liveViewFrom = null;
    if (!visible) {
      this.stopTypingOnConnectedClient();
    }
    // Blur compacts the application-owned view cache while keeping SDK listeners warm;
    // focus immediately rebuilds the complete loaded projection from the SDK store.
    this.rows.markAll();
    this.refresh();
    this.refreshTyping();
  }

  /** Deterministic diagnostics for the bounded Conversation Runtime retention policy. */
  resources(): {
    readonly listenerCount: number;
    readonly retainedBytes: number;
  } {
    if (!this.room || !this.connectedClient) {
      return { listenerCount: 0, retainedBytes: 0 };
    }
    return {
      listenerCount: 11 + (typeof window === 'undefined' ? 0 : 1),
      retainedBytes:
        this.rows.size * RETAINED_EVENT_BYTES +
        this.shields.size * RETAINED_SHIELD_BYTES +
        this.relevantSenders.size * RETAINED_SENDER_BYTES,
    };
  }

  /** Detach listeners and clear the timeline. */
  close(): void {
    this.readReceiptSubscription?.unsubscribe();
    this.readReceiptSubscription = null;
    this.readReceiptInFlightId = null;
    // Stop typing on the client this room was OPENED on, like the listener detach below.
    // `setTyping` resolves via `openContext()`/`matrix.instance`, but close is deferred
    // through the URL-driven open effect, so after an account switch that is already the
    // incoming client. Sending there PUTs typing into a room the new account may not be in
    // and leaves the outgoing account typing until the server's own timeout.
    this.stopTypingOnConnectedClient();
    this.stopFocusListener?.();
    this.stopFocusListener = null;
    this.room?.off(RoomEvent.Timeline, this.onTimeline);
    this.room?.off(RoomEvent.LocalEchoUpdated, this.onLocalEcho);
    this.room?.off(RoomEvent.Receipt, this.onReceipt);
    this.room?.off(RoomEvent.Redaction, this.onRedaction);
    this.room?.off(RoomStateEvent.Members, this.onMember);
    // Detach from the client open() attached to, NOT `matrix.instance` (the active account),
    // or the old client's listeners stay attached after an account switch.
    const client = this.connectedClient;
    if (client) {
      client.off(MatrixEventEvent.Decrypted, this.onDecrypted);
      client.off(MatrixEventEvent.Replaced, this.onReplaced);
      client.off(RoomMemberEvent.Typing, this.onTyping);
      client.off(CryptoEvent.UserTrustStatusChanged, this.onTrust);
      client.off(CryptoEvent.DevicesUpdated, this.onTrust);
      client.off(CryptoEvent.KeysChanged, this.onTrust);
    }
    this.connectedClient = null;
    this.room = null;
    this.roomId = null;
    this.lastReadEventId = null;
    this.liveViewFrom = null;
    this._readMarker.set(null);
    this._firstUnreadId.set(null);
    this._oldestEventId.set(null);
    this.relevantSenders.clear();
    this.rows.clear();
    this.projectedTimeline = null;
    this.projectedEncryption = '';
    this.shields.clear();
    this.encryption = new RoomEncryptionFlags();
    this._messages.set([]);
    this._typingNames.set([]);
    this._canRedactOthers.set(false);
    this._canLoadOlder.set(false);
    // An in-flight backfill (loadOlder, or a date jump's loop) belongs to the room being torn
    // down; leaving this true strands the NEXT room's viewport-fill loop, which bails while
    // it is set.
    this._loadingOlder.set(false);
    this._tombstone.set(null);
  }

  /**
   * Recompute whether the user's power level meets the room's `redact` requirement. Own
   * messages are always deletable elsewhere; this only widens the affordance to moderators.
   */
  private updateRedactOthersPermission(room: Room): void {
    const userId = this.connectedClient?.getUserId() ?? null;
    if (!userId) {
      this._canRedactOthers.set(false);
      return;
    }
    this._canRedactOthers.set(
      this.messagePolicy.canRedactOthers({
        accountId: userId,
        roomId: room.roomId,
      }),
    );
  }

  /** Page in older history (backward pagination of the live timeline). */
  loadOlder(): Observable<void> {
    return defer(() => {
      const room = this.room;
      const client = this.connectedClient;
      if (!this.visible || !room || !client || this._loadingOlder()) {
        return of(void 0);
      }
      this._loadingOlder.set(true);
      return from(scrollbackLive(client, room, SCROLLBACK)).pipe(
        tap(() => this.refresh()),
        // Reset on success *or* error, or a failed scrollback leaves pagination disabled.
        finalize(() => this._loadingOlder.set(false)),
        map(() => void 0),
      );
    });
  }

  /**
   * Page history back until `eventId` is in the live timeline, so a jump to a pinned or
   * searched message that was never loaded has an element to scroll to. Emits whether it
   * is now loaded; bounded by {@link MAX_JUMP_PAGES}, like a date jump. Cold.
   */
  loadEvent(eventId: string): Observable<boolean> {
    return defer(() => {
      const ctx = this.openContext();
      if (!ctx) return of(false);
      const { client, room } = ctx;
      const loaded = (): boolean => room.findEventById(eventId) !== undefined;
      if (loaded()) return of(true);
      this._loadingOlder.set(true);
      return from(this.pageBackLoop(client, room, loaded)).pipe(
        tap(() => this.refresh()),
        finalize(() => this._loadingOlder.set(false)),
      );
    });
  }

  /**
   * Find the first message on or after `dayStartMs` and page history back until it is
   * loaded, so the caller can scroll to it. Cold; runs on subscribe.
   *
   * `timestampToEvent` (MSC3030) answers for the WHOLE room, so it can name an event
   * thousands back that this client has never seen; scrolling to an id the DOM lacks
   * silently does nothing, hence the paging loop.
   *
   * The loop is `scrollback`, extending the LIVE timeline rather than opening a windowed
   * timeline at the target: leaving the live timeline breaks read receipts and unread state.
   * The cost is reaching only dates within {@link MAX_JUMP_PAGES} pages; anything further
   * reports `too-far`.
   *
   * Every outcome is named: a silent `null` couldn't tell "the room is empty" from a server
   * that can't do this or a date before the room existed.
   */
  jumpToDate(dayStartMs: number): Observable<JumpToDateResult> {
    return defer(() => {
      const ctx = this.openContext();
      if (!ctx) {
        return of<JumpToDateResult>({ kind: 'no-event' });
      }
      const { client, room } = ctx;
      // Forward: the first event at or after midnight. Backward would land on the PREVIOUS
      // day's last message when the day's own messages all sit later in the day.
      return from(
        client.timestampToEvent(room.roomId, dayStartMs, Direction.Forward),
      ).pipe(
        switchMap((response) =>
          this.pageBackTo(
            client,
            room,
            response.event_id as string,
            dayStartMs,
          ),
        ),
        catchError((err: unknown) => of(classifyJumpFailure(err))),
      );
    });
  }

  /**
   * Scroll history back until `eventId` is loaded, then name something the list can
   * actually scroll to.
   *
   * The server's event id is a POSITION, not a target: `findEventById` answers for the raw
   * event, but the timeline renders only the projection. The first event of a day is often
   * an `m.reaction`, an `m.replace` edit or a hidden membership line, and in an encrypted
   * room `scrollback` resolves BEFORE decryption, so the target is momentarily a raw
   * `m.room.encrypted` the projection drops. Returning the raw id then jumps to a missing
   * element: the dialog closes, nothing moves, no error is shown.
   *
   * So the raw id only decides how far back to page; the target is the first RENDERED
   * message at or after the requested midnight.
   *
   * Paging stops early when the server runs out of history, or a room whose start has been
   * reached would burn every remaining page on empty requests.
   */
  private pageBackTo(
    client: MatrixClient,
    room: Room,
    eventId: string,
    dayStartMs: number,
  ): Observable<JumpToDateResult> {
    const loaded = (): boolean => room.findEventById(eventId) !== undefined;
    if (loaded()) {
      return of(this.renderableFrom(dayStartMs));
    }
    return defer(() => {
      this._loadingOlder.set(true);
      return from(this.pageBackLoop(client, room, loaded));
    }).pipe(
      tap(() => this.refresh()),
      // Reset on success *or* error, as loadOlder does; a stuck flag disables pagination.
      finalize(() => this._loadingOlder.set(false)),
      map((reached): JumpToDateResult =>
        reached ? this.renderableFrom(dayStartMs) : { kind: 'too-far' },
      ),
    );
  }

  /**
   * The first projected message at or after `dayStartMs`, or `no-event` when nothing from
   * then on renders. `messages()` is in timeline order.
   */
  private renderableFrom(dayStartMs: number): JumpToDateResult {
    const target = this._messages().find((m) => m.timestamp >= dayStartMs);
    return target
      ? { kind: 'found', eventId: target.id }
      : { kind: 'no-event' };
  }

  private async pageBackLoop(
    client: MatrixClient,
    room: Room,
    loaded: () => boolean,
  ): Promise<boolean> {
    for (let page = 0; page < MAX_JUMP_PAGES; page++) {
      const before = room.getLiveTimeline().getEvents().length;
      await scrollbackLive(client, room, SCROLLBACK);
      // The user can leave during up to 20 sequential requests, and nothing unsubscribes this
      // (the subscription is tied to the PAGE, not the open room). Without this check the
      // loop keeps paging a closed room and its `finalize` clears `_loadingOlder` for
      // whichever room is open by then, stranding that room's viewport-fill loop.
      if (this.room !== room) {
        return false;
      }
      if (loaded()) {
        return true;
      }
      if (room.getLiveTimeline().getEvents().length === before) {
        return false; // start of the room: no more history to page in
      }
    }
    return false;
  }

  /**
   * The open room plus the immutable Conversation handle's connected client, or null when
   * the handle is blurred or released. Every cold action in `TimelineActionsService`
   * resolves this inside its `defer()` (on subscribe, never on construction); anchoring the
   * client here stops a retained handle retargeting when Active Account changes.
   *
   * Public so the action surface owns no room state and never re-derives the open room.
   */
  openContext(): TimelineContext | null {
    const room = this.room;
    const client = this.connectedClient;
    if (!this.visible || !room || !client) {
      return null;
    }
    return { client, room };
  }

  /**
   * Broadcast whether the local user is typing in the open room; fire-and-forget. Starts
   * are throttled to one `sendTyping(true)` per {@link TYPING_REFRESH_MS}; the server keeps
   * the flag alive for {@link TYPING_TIMEOUT_MS}, so it never lapses mid-compose. A no-op
   * when no room is open.
   */
  setTyping(typing: boolean, owner: TypingOwner = 'room'): void {
    const ctx = this.openContext();
    if (!ctx) {
      return;
    }
    if (typing) {
      this.typingOwners.add(owner);
    } else {
      this.typingOwners.delete(owner);
      if (this.typingOwners.size) {
        // Another composer still holds a draft: sending the stop would mark us not typing
        // while its text sits there, and nothing re-announces until the next keystroke
        // (unbounded, not TYPING_TIMEOUT_MS).
        return;
      }
    }

    const now = Date.now();
    if (typing) {
      if (this.typingSentAt && now - this.typingSentAt < TYPING_REFRESH_MS) {
        return; // already marked typing and refreshed recently — nothing to do
      }
      this.typingSentAt = now;
      void ctx.client.sendTyping(ctx.room.roomId, true, TYPING_TIMEOUT_MS);
    } else {
      if (!this.typingSentAt) {
        return; // we weren't marked as typing — nothing to clear
      }
      this.typingSentAt = 0;
      void ctx.client.sendTyping(ctx.room.roomId, false, 0);
    }
  }

  /**
   * The typing-stop {@link close} sends, bound to {@link connectedClient} rather than the
   * active one. Local ownership is always cleared; the network stop is conditional because
   * the final account may already be signed out by the time the deferred close runs.
   */
  private stopTypingOnConnectedClient(): void {
    const client = this.connectedClient;
    const room = this.room;
    const hadSentTyping = this.typingSentAt !== 0;
    this.typingSentAt = 0;
    this.typingOwners.clear();
    // `isInitialized` is not redundant: `connectedClient` is cleared only by close(), so
    // after a sign-out it still holds a stopped, logged-out client and we would PUT typing
    // on a revoked token. An account SWITCH leaves it true, so the account pinning holds.
    if (!client || !room || !hadSentTyping || !this.matrix.isInitialized) {
      return;
    }
    // Caught, unlike the composer's `setTyping`: this runs during teardown, where the room
    // may be one the account has left and no surface remains to report on.
    void client.sendTyping(room.roomId, false, 0).catch(() => undefined);
  }

  /** Re-read the open room's typing set into `typingNames`, excluding the local user. */
  private refreshTyping(): void {
    const ctx = this.openContext();
    if (!ctx) {
      this._typingNames.set([]);
      return;
    }
    const selfId = ctx.client.getUserId();
    const names = ctx.room
      .getMembers()
      .filter((member) => member.typing && member.userId !== selfId)
      .map((member) => member.name);
    this._typingNames.set(names);
  }

  /** The raw (effective) JSON of an event for "view source", or null if not loaded. */
  rawEvent(roomId: string, eventId: string): object | null {
    const event = this.connectedClient?.getRoom(roomId)?.findEventById(eventId);
    return event?.getEffectiveEvent() ?? null;
  }

  /**
   * Everyone who reacted to `eventId`, grouped by reaction key: the full list behind the
   * pills' capped hint, read on demand. `findEventById` also searches thread timelines, so
   * thread rows work too. Empty when the room isn't open or the event isn't loaded; a
   * snapshot, not a live signal.
   */
  reactionDetails(eventId: string): ReactionDetail[] {
    const ctx = this.openContext();
    const event = ctx?.room.findEventById(eventId);
    if (!ctx || !event) {
      return [];
    }
    return reactionDetailsFor(ctx.client, ctx.room, event);
  }

  private refresh(): void {
    const room = this.room;
    const client = this.connectedClient;
    if (!room || !client) {
      return;
    }
    const liveTimeline = room.getLiveTimeline();
    const loadedEvents = liveTimeline.getEvents();
    const encrypted = this.encryption.isEncrypted(room);
    const unencryptedShield = unencryptedShieldFor(room, encrypted);
    const events = this.visible
      ? loadedEvents
      : loadedEvents.slice(-RETAINED_EVENT_LIMIT);
    // Every row is re-checked when what changed cannot be pinned to rows: a replaced live
    // timeline (a trim or a gappy sync) may have taken away what kept rows quote, and
    // encryption turning on changes every plaintext row's shield and link preview.
    const encryption = `${encrypted}:${room.hasEncryptionStateEvent()}`;
    this.rows.beginPass(
      liveTimeline !== this.projectedTimeline ||
        encryption !== this.projectedEncryption,
    );
    this.projectedTimeline = liveTimeline;
    this.projectedEncryption = encryption;
    // Divider anchor: the first surviving message from someone else after the read marker,
    // tested on the RAW event order. m.fully_read can name an event the projection drops
    // (hidden system line, reaction, edit, pin), and deriving it from the projected list
    // would silently lose the divider.
    const marker = this._readMarker();
    const markerIdx = marker
      ? events.findIndex((e) => e.getId() === marker)
      : -1;
    const selfId = client.getUserId();
    let firstUnread: string | null = null;
    // Rows this pass fingerprinted, whose shields may need resolving.
    const checked: MatrixEvent[] = [];
    let subjectsMoved = false;
    const views: MessageView[] = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      // Edits (m.replace) are aggregated onto their target, so hidden. Threaded replies are
      // projected by ThreadsService; the SDK keeps them out of the live timeline when thread
      // support is on, but guard in case any leak. Membership/room-state changes ride along
      // as system lines.
      if (isThreadReply(e)) {
        continue;
      }
      const id = e.getId() ?? '';
      if (!isDisplayableMessage(e)) {
        if (!isPresentableSystemEvent(e)) {
          continue;
        }
        const view = this.systemRow(client, room, e, id);
        // Dropped when there is nothing to say (a no-op change) or the user hid this category,
        // collapsing the row entirely. The row stays cached, so re-showing the category
        // costs nothing.
        if (
          view?.kind === 'event' &&
          view.systemCategory &&
          this.showsCategory(view.systemCategory)
        ) {
          views.push(view);
        }
        continue;
      }
      // A system line is not an unread *message*, so only real messages from someone else
      // can anchor the divider.
      if (
        markerIdx >= 0 &&
        i > markerIdx &&
        !firstUnread &&
        e.getSender() !== selfId
      ) {
        firstUnread = id;
      }
      // Reuse the view (keeping object identity for OnPush) unless something this event
      // renders from changed. The async shield is part of the fingerprint so a trust change
      // re-projects; it belongs to the event supplying the row's text, its latest edit.
      const subjectId = shieldSubject(e).getId() ?? '';
      const shield =
        unencryptedShield(e) ?? this.shields.get(subjectId) ?? null;
      const reused = this.rows.reusable(id, e.replyEventId, shield);
      if (reused) {
        if (reused.view) views.push(reused.view);
        continue;
      }
      checked.push(e);
      // A newer edit supplies the row's text: the old one's shield is no longer shown.
      const previousSubject = this.rows.previous(id)?.subjectId;
      subjectsMoved ||=
        previousSubject !== undefined && previousSubject !== subjectId;
      const view = this.messageRow(client, room, e, id, shield, subjectId);
      if (view) views.push(view);
    }
    const { pruned, rechecked } = this.rows.endPass();
    if (pruned || rechecked > 0) {
      const relevant = this.rows.renderedMembers();
      this.relevantSenders = this.visible
        ? relevant
        : new Set([...relevant].slice(0, RETAINED_SENDER_LIMIT));
    }
    this._oldestEventId.set(events[0]?.getId() ?? null);
    // Null when there is no marker, the marker isn't loaded, or nothing followed it.
    this._firstUnreadId.set(markerIdx >= 0 ? firstUnread : null);
    // Drop shields of events no longer shown (redacted-away, replaced by their remote id,
    // scrolled out under a window cap, or superseded by a newer edit), so the map can't
    // grow unbounded across a session.
    if ((pruned || subjectsMoved) && this.shields.size > 0) {
      const subjects = this.rows.shieldSubjects();
      for (const id of [...this.shields.keys()]) {
        if (!subjects.has(id)) {
          this.shields.delete(id);
        }
      }
    }
    this._messages.set(views);
    // Resolve encrypted-message authenticity shields off the async crypto API; when any
    // resolve to a new value they're folded into the cache rev and re-projected.
    void this.resolveShields(room, checked);
    this._canLoadOlder.set(
      liveTimeline.getPaginationToken(Direction.Backward) !== null,
    );
    // The room is on-screen: mark its latest message read while the window is focused
    // (deduped, so live messages clear the badge but paginating older history doesn't
    // re-send). Skipped while unfocused so an open room still shows unread; onFocus re-acks.
    this.markRead(events);
    // A tombstone lands as a state event → onTimeline → here; keep the banner current.
    this.updateTombstone(room);
  }

  /**
   * Project a message row the refresh could not reuse as it was: re-fingerprint it, and
   * re-project it only when the fingerprint moved.
   */
  private messageRow(
    client: MatrixClient,
    room: Room,
    e: MatrixEvent,
    id: string,
    shield: MessageShield | null,
    subjectId: string,
  ): MessageView | null {
    const roomEncrypted = this.encryption.isEncrypted(room);
    const { content, rest } = revisionOf(client, room, e, roomEncrypted);
    const revision = rest + '\x1f' + shieldKey(shield);
    const members = new Set<string>();
    collectMessageSenders(client, room, e, members);
    const previous = this.rows.previous(id);
    const unchanged =
      previous?.content === content && previous.rest === revision;
    const view = unchanged
      ? previous.view
      : projectMessage(
          client,
          room,
          e,
          shield,
          roomEncrypted,
          this.mediaPipeline,
        );
    this.rows.store(
      id,
      {
        content,
        rest: revision,
        view,
        shield,
        subjectId,
        members: [...members],
      },
      !unchanged,
    );
    return view;
  }

  /**
   * Project a system line the refresh could not reuse. A state / membership change is
   * normalized and presented before the user's category visibility applies; the line keeps
   * its view object while its text stays the same.
   */
  private systemRow(
    client: MatrixClient,
    room: Room,
    e: MatrixEvent,
    id: string,
  ): MessageView | null {
    const reused = this.rows.reusable(id, undefined, null);
    if (reused) {
      return reused.view;
    }
    const projected = projectMessage(
      client,
      room,
      e,
      null,
      this.encryption.isEncrypted(room),
      this.mediaPipeline,
    );
    const presented =
      projected?.kind === 'event' && projected.systemCategory
        ? projected
        : null;
    const summary = presented ? (presented.summary ?? presented.body) : '';
    const previous = this.rows.previous(id);
    const unchanged = !!previous?.view && previous.rest === summary;
    const view = unchanged ? previous.view : presented;
    // A system line renders no "seen by" avatars (Message Presentation sets
    // `readReceipts: []`), so its readers are nobody this row depends on.
    const members = new Set<string>();
    collectMessageSenders(client, room, e, members, { receipts: false });
    // A membership line names the TARGET (state_key), whose display name can load late;
    // register it so RoomStateEvent.Members re-projects the line.
    const target = e.getStateKey();
    if (e.getType() === EventType.RoomMember && target) {
      members.add(target);
    }
    this.rows.store(
      id,
      {
        content: '',
        rest: summary,
        view,
        shield: null,
        subjectId: id,
        members: [...members],
      },
      !unchanged,
    );
    return view;
  }

  /**
   * Recompute the open room's tombstone. Guarded so an unchanged tombstone doesn't churn
   * the signal (and re-render the banner) each refresh.
   */
  private updateTombstone(room: Room): void {
    const content = liveRoomState(room)
      ?.getStateEvents?.(EventType.RoomTombstone, '')
      ?.getContent();
    const replacement =
      typeof content?.['replacement_room'] === 'string'
        ? content['replacement_room']
        : null;
    if ((this._tombstone()?.replacementRoomId ?? null) === replacement) {
      return;
    }
    this._tombstone.set(
      replacement
        ? {
            replacementRoomId: replacement,
            body: typeof content?.['body'] === 'string' ? content['body'] : '',
          }
        : null,
    );
  }

  /**
   * Resolve authenticity shields for the room's encrypted messages off the async crypto
   * API, storing them per event id. When a shield changes it triggers one more
   * {@link refresh} (changed rows only), which re-enters here, finds nothing new and stops.
   * Best-effort: a room switch mid-resolve or a missing crypto API bails without touching
   * state.
   */
  private async resolveShields(
    room: Room,
    events: readonly MatrixEvent[] = room.getLiveTimeline().getEvents(),
    force = false,
  ): Promise<void> {
    const crypto = this.connectedClient?.getCrypto?.() ?? null;
    if (!crypto) {
      return;
    }
    // The crypto store may know the room is encrypted when its state does not say so.
    void this.encryption.refresh(crypto, room.roomId).then((encrypted) => {
      if (encrypted && this.roomId === room.roomId) {
        this.refresh();
      }
    });
    const encrypted = events
      .filter((e) => isDisplayableMessage(e) && !isThreadReply(e))
      .map(shieldSubject)
      .filter((subject) => subject.isEncrypted());
    const changed = await resolveShieldsInto(crypto, encrypted, this.shields, {
      force,
      isStale: () => this.roomId !== room.roomId,
    });
    if (changed && this.roomId === room.roomId) {
      this.refresh();
    }
  }

  /**
   * Send a read receipt for the active room's latest *confirmed* event, but ONLY while the
   * window is focused, so an open room still accumulates unread like any other channel;
   * {@link onFocus} re-acks on return. Likewise while {@link CONVERSATION_ATTENTION} says
   * nobody is looking (App lock covers the app); the constructor's attention effect re-acks.
   * Deduped on the last-acked event id so a no-op refresh (decryption, pagination) doesn't
   * re-send. Pending local echoes are skipped (the SDK rejects a receipt on an unsent event)
   * and a missing/failed receipt API is swallowed so viewing a room never throws. `events`
   * defaults to the live timeline so the focus re-ack runs without a refresh's snapshot.
   */
  private markRead(events?: readonly MatrixEvent[]): void {
    const client = this.connectedClient;
    if (!this.visible || !client || !this.room) {
      return;
    }
    // Unfocused: hold the receipt so unread accumulates; onFocus re-acks on return.
    if (!windowHasFocus()) {
      return;
    }
    // Covered by App lock: focused, but nobody is looking; the attention effect re-acks.
    if (this.attention && !untracked(this.attention.attentive)) {
      return;
    }
    const list = events ?? this.room.getLiveTimeline().getEvents();
    let latest: MatrixEvent | undefined;
    for (let i = list.length - 1; i >= 0 && !latest; i--) {
      if (!list[i].status) latest = list[i];
    }
    const id = latest?.getId() ?? null;
    if (
      !latest ||
      !id ||
      id === this.lastReadEventId ||
      id === this.readReceiptInFlightId
    ) {
      return;
    }
    const accountId = client.getUserId();
    if (!accountId) {
      return;
    }
    const roomId = this.room.roomId;
    this.readReceiptSubscription?.unsubscribe();
    this.readReceiptInFlightId = id;
    const subscription = this.messageAdapter
      .acknowledge({ key: { accountId, roomId }, messageId: id })
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
          if (
            outcome.kind === 'applied' &&
            this.connectedClient === client &&
            this.room?.roomId === roomId
          ) {
            this.lastReadEventId = id;
          }
        },
        error: () => undefined,
      });
    this.readReceiptSubscription = subscription.closed ? null : subscription;
  }

  /** The room's persisted fully-read marker event id (`m.fully_read`), or null. */
  private readMarkerOf(room: Room): string | null {
    const content = room.getAccountData?.(EventType.FullyRead)?.getContent();
    const eventId = content?.['event_id'];
    return typeof eventId === 'string' ? eventId : null;
  }
}

/**
 * True for a threaded reply that lives only in its thread: it carries a thread root id but
 * is not itself the root. (A plain `m.in_reply_to` reply has no `threadRootId` and stays in
 * the timeline.)
 */
function isThreadReply(event: MatrixEvent): boolean {
  return event.threadRootId !== undefined && !event.isThreadRoot;
}
