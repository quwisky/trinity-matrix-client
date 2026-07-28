import { Injectable, effect, inject, signal } from '@angular/core';
import {
  Direction,
  EventType,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import {
  Observable,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access-matrix-client';
import { MediaService } from '@trinity/data-access-media';
import {
  PrivacySettingsService,
  SystemLineSettingsService,
  type VoiceRecording,
} from '@trinity/platform-native';
import {
  annotationContent,
  safeBuildMessageView,
  buildTimelineEventView,
  describeTimelineEvent,
  type SystemLineCategory,
  collectMessageSenders,
  editMessageContent,
  isDisplayableMessage,
  isDisplayableStateEvent,
  isPollStart,
  pollSignature,
  pollStartContent,
  pollResponseContent,
  pollEndContent,
  mediaCaptionFields,
  myReactionId,
  reactionDetailsFor,
  reactionsFor,
  readReceiptsFor,
  locationMessageContent,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
  voiceMessageContent,
  TYPING_REFRESH_MS,
  TYPING_TIMEOUT_MS,
  liveRoomState,
  type MessageView,
  type MessageShield,
  type Mention,
  type ReactionDetail,
} from '@trinity/util-matrix';
import { resolveShieldsInto, shieldKey } from './shields';

const SCROLLBACK = 30;

/** File extension for a recorded voice clip's MIME type (best-effort, default webm). */
function voiceExtension(mimeType: string): string {
  if (mimeType.includes('ogg')) {
    return 'ogg';
  }
  if (mimeType.includes('mp4') || mimeType.includes('mpeg')) {
    return 'm4a';
  }
  return 'webm';
}

/** The open room's tombstone: it was replaced by a successor room (`m.room.tombstone`). */
export interface RoomTombstone {
  /** The successor room id to move to. */
  replacementRoomId: string;
  /** The upgrade message (e.g. "This room has been replaced"), if any. */
  body: string;
}

/**
 * Projects the *active* room's live timeline into a `messages` signal of view
 * models. Re-maps on new events and on async E2EE decryption. The shell opens one
 * room at a time; `matrix-js-sdk` remains the source of truth.
 *
 * With thread support enabled on the client (see {@link MatrixClientService}), the
 * SDK routes threaded replies into per-thread timelines, so they are absent from
 * the room's live timeline here — only thread *roots* remain in the main view. The
 * thread roots and their replies are projected separately by `ThreadsService`.
 *
 * Deliberately not a `projectFromClient` projection: this service is scoped to the OPEN
 * ROOM, binding to a `Room` as well as to the client, so its lifetime is open()/close()
 * rather than the client's. That is also why it needs no account-switch re-projection —
 * a switch closes the open room first (`rooms.page.ts`, `runOnAccount`). It does take the
 * shared `coalesce`, which is the half that applies.
 */
@Injectable({ providedIn: 'root' })
export class TimelineService {
  private readonly matrix = inject(MatrixClientService);
  private readonly mediaSvc = inject(MediaService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly systemLines = inject(SystemLineSettingsService);

  private readonly _messages = signal<MessageView[]>([]);
  readonly messages = this._messages.asReadonly();

  private readonly _loadingOlder = signal(false);
  readonly loadingOlder = this._loadingOlder.asReadonly();

  private readonly _canLoadOlder = signal(false);
  readonly canLoadOlder = this._canLoadOlder.asReadonly();

  /**
   * Id of the OLDEST raw event in the loaded window — including ones the projection drops
   * (system lines the user hid, edits, reactions). The message lists use it to tell whether
   * a backfill round actually pulled in history: the oldest *rendered* row can't answer that
   * once rows are filtered out, so a page of purely-hidden events would look like "nothing
   * was prepended" and stop the viewport-filling loop with history still to load.
   */
  private readonly _oldestEventId = signal<string | null>(null);
  readonly oldestEventId = this._oldestEventId.asReadonly();

  // Display names of the *other* members currently typing in the open room, projected
  // from the room's `m.typing` ephemeral (via RoomMemberEvent.Typing). Drives the
  // "X is typing…" row under the timeline.
  private readonly _typingNames = signal<string[]>([]);
  readonly typingNames = this._typingNames.asReadonly();

  // Whether the current user's power level lets them redact OTHER users' messages
  // (a moderator/admin). Computed on room open; the homeserver is the real authority,
  // so a mid-session power change is picked up on the next open (and the server rejects
  // a redaction we shouldn't have sent). Gates the delete affordance on others' rows.
  private readonly _canRedactOthers = signal(false);
  readonly canRedactOthers = this._canRedactOthers.asReadonly();

  // The open room's tombstone (it was upgraded/replaced), or null. Drives a banner
  // that links to the successor room. Recomputed on open + when state changes.
  private readonly _tombstone = signal<RoomTombstone | null>(null);
  readonly tombstone = this._tombstone.asReadonly();

  // Timestamp (ms) of the last `sendTyping(true)` we issued for the open room, so we
  // refresh the flag at most every {@link TYPING_REFRESH_MS} instead of per keystroke;
  // 0 means we are not currently marked as typing.
  private typingSentAt = 0;

  private roomId: string | null = null;

  /**
   * The client {@link open} attached its client-level listeners to. `matrix.instance`
   * follows the ACTIVE account, so re-reading it in {@link close} after an account
   * switch would detach from the *new* client and leak every listener on the old one —
   * which is still signed in and syncing. Detach from what we attached to.
   */
  private connectedClient: MatrixClient | null = null;

  /**
   * Coalesce listener-driven re-projections into one per microtask.
   *
   * The SDK emits Timeline/Decrypted once **per event**, so a burst — paginating 30
   * messages, or decrypting a backfilled room — fires the handler once per event, and
   * {@link refresh} walks and fingerprints *every* loaded event each time. Refreshing
   * per event is therefore quadratic in the burst. Collapse the burst into a single
   * pass, exactly as the client projections do.
   *
   * refresh() writes the projection signals, and under zoneless a signal write
   * schedules change detection on its own — so typing indicators and shield changes
   * flush without waiting for an incidental tick.
   *
   * The batching itself is `coalesce`, shared with the client projections — this service
   * is room-scoped so it takes that primitive alone, as {@link PinnedMessagesService}
   * does. The `room` guard below is why it stays wrapped: a queued pass must not run
   * against a closed room.
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
    // Re-project the open room when a system-line category is toggled: the filter runs during
    // refresh, so without this the timeline would keep the lines until the next live event
    // happened to arrive. The effect's first run is the initial read of those signals, not a
    // change, so it must not schedule a refresh of its own.
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

  /** The room currently open in the timeline, or null when none is. Lets other
   * services (e.g. NotificationService) tell whether the user is viewing a room. */
  get openRoomId(): string | null {
    return this.roomId;
  }
  private room: Room | null = null;

  // Per-event projection cache keyed by event id. Each entry stores the view model
  // and a `rev` fingerprint of everything {@link buildMessageView} reads that can
  // change while the room is open (see {@link eventRevision}). On refresh an event
  // is re-projected only when its fingerprint changes; otherwise the existing view
  // object is reused so its OnPush row never re-renders — instead of rebuilding the
  // entire timeline (and re-running DOMPurify) on every live event.
  private readonly viewCache = new Map<
    string,
    { rev: string; view: MessageView }
  >();

  // Latest event we've already sent a read receipt for, so live messages while
  // the room is open mark read without re-sending on every refresh — and
  // pagination/backfill (which leaves the latest unchanged) doesn't re-ack.
  private lastReadEventId: string | null = null;

  // The persisted fully-read marker (`m.fully_read`) as it stood when the room was
  // opened — captured once so the "New messages" divider stays put for the whole
  // session even as markRead advances the server-side marker. Null when the room has
  // no marker yet (first visit) or none is loaded.
  private readonly _readMarker = signal<string | null>(null);

  /**
   * Event id of the first unread message: the first message after the on-open
   * {@link _readMarker} that isn't the user's own. Drives the "New messages" divider and the
   * jump-to-unread control; null when nothing is unread.
   *
   * Resolved during {@link refresh} against the RAW timeline order rather than computed from
   * the projected list. `markRead` acks the newest raw event, so `m.fully_read` can name an
   * event the projection never renders — a hidden system line, but equally a reaction, an
   * edit or a pin — and looking the marker up among the rendered rows would find nothing and
   * silently drop the divider.
   */
  private readonly _firstUnreadId = signal<string | null>(null);
  readonly firstUnreadId = this._firstUnreadId.asReadonly();

  // User ids the current projection renders a member for: every message's sender
  // (its header) plus every reply's quoted sender (its preview). Recomputed each
  // refresh; the member listener re-projects only when one of *these* members
  // loads/changes, so a full lazy member-load doesn't re-map once per member.
  private relevantSenders = new Set<string>();

  private readonly onTimeline = (): void => this.scheduleRefresh();
  private readonly onLocalEcho = (): void => this.scheduleRefresh();
  // Others' read receipts moved — re-project so the "seen by" avatars follow them.
  private readonly onReceipt = (): void => this.scheduleRefresh();
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.scheduleRefresh();
    }
  };
  // Which edit a message resolves to can change without any new event arriving — an
  // edit being redacted re-aggregates the message onto an earlier revision. That is a
  // different signal from RoomEvent.Timeline (nothing was added or removed from the
  // timeline), so without this the row keeps rendering the version that just went away.
  private readonly onReplaced = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.scheduleRefresh();
    }
  };
  // A member's display name/avatar can arrive (lazy loading) or change *after* the
  // events that reference it — as a header sender or, more subtly, as a reply
  // preview's quoted sender, which would otherwise stay stuck on the raw mxid +
  // initials. The room re-emits its state's Members event for both membership and
  // profile changes; gate on `relevantSenders` so only a referenced member re-maps.
  private readonly onMember = (
    _event: MatrixEvent,
    _state: RoomState,
    member: RoomMember,
  ): void => {
    if (
      member.roomId === this.roomId &&
      this.relevantSenders.has(member.userId)
    ) {
      this.scheduleRefresh();
    }
  };

  // A member started/stopped typing in the open room. The event carries the changed
  // member; re-read the room's whole typing set so the signal always reflects everyone
  // currently typing, not just this one delta.
  private readonly onTyping = (
    _event: MatrixEvent,
    member: RoomMember,
  ): void => {
    if (member.roomId === this.roomId) {
      this.refreshTyping();
    }
  };

  /** The window regained focus while a room is open — send the read receipt we
   * held back while unfocused, so the open room's badge clears now the user is
   * actually looking at it. */
  private readonly onFocus = (): void => this.markRead();

  /** Resolved authenticity shields per event id (async; patched back via {@link refresh}). */
  private readonly shields = new Map<string, MessageShield | null>();

  // Cross-signing / device trust changed: a message's shield may flip (e.g. a device
  // the sender just verified). Force a full re-resolve of the open room's shields
  // (bypassing the per-event skip that a benign refresh uses).
  private readonly onTrust = (): void => {
    if (this.room) {
      void this.resolveShields(this.room, undefined, true);
    }
  };

  /** Start projecting a room's live timeline; attaches live + decryption listeners. */
  open(roomId: string): void {
    if (this.roomId === roomId || !this.matrix.isInitialized) {
      return;
    }
    this.close();

    const client = this.matrix.instance;
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
    room.on(RoomStateEvent.Members, this.onMember);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    client.on(MatrixEventEvent.Replaced, this.onReplaced);
    client.on(RoomMemberEvent.Typing, this.onTyping);
    client.on(CryptoEvent.UserTrustStatusChanged, this.onTrust);
    client.on(CryptoEvent.DevicesUpdated, this.onTrust);
    client.on(CryptoEvent.KeysChanged, this.onTrust);
    // Capture the persisted read marker BEFORE the first refresh (which marks read and
    // advances it), so the "New messages" divider anchors where the user left off.
    this._readMarker.set(this.readMarkerOf(room));
    this.updateRedactOthersPermission(room);
    // Re-ack the open room on refocus: while unfocused markRead holds the receipt
    // so its unread accrues, so we mark it read again when the window returns.
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.onFocus);
    }
    // Projects the timeline and sends the initial read receipt; subsequent live
    // messages re-ack through the same path (see {@link markRead}).
    this.refresh();
  }

  /** Detach listeners and clear the timeline. */
  close(): void {
    // Don't leave ourselves marked as typing in a room we're navigating away from.
    this.setTyping(false);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.onFocus);
    }
    this.room?.off(RoomEvent.Timeline, this.onTimeline);
    this.room?.off(RoomEvent.LocalEchoUpdated, this.onLocalEcho);
    this.room?.off(RoomEvent.Receipt, this.onReceipt);
    this.room?.off(RoomStateEvent.Members, this.onMember);
    // Detach from the client open() attached to — NOT `matrix.instance`, which follows
    // the active account and would leave the old client's listeners attached forever
    // after an account switch.
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
    this._readMarker.set(null);
    this._firstUnreadId.set(null);
    this._oldestEventId.set(null);
    this.relevantSenders.clear();
    this.viewCache.clear();
    this.shields.clear();
    this._messages.set([]);
    this._typingNames.set([]);
    this._canRedactOthers.set(false);
    this._canLoadOlder.set(false);
    this._tombstone.set(null);
  }

  /**
   * Recompute whether the current user may redact other people's messages in `room`:
   * their power level meets the room's `redact` requirement. Own messages are always
   * deletable elsewhere; this only widens the affordance to moderators.
   */
  private updateRedactOthersPermission(room: Room): void {
    const userId = this.matrix.isInitialized
      ? this.matrix.instance.getUserId()
      : null;
    if (!userId) {
      this._canRedactOthers.set(false);
      return;
    }
    const level = room.getMember(userId)?.powerLevel ?? 0;
    this._canRedactOthers.set(
      liveRoomState(room)?.hasSufficientPowerLevelFor?.('redact', level) ??
        false,
    );
  }

  /** Page in older history (backward pagination via `scrollback`). */
  loadOlder(): Observable<void> {
    const room = this.room;
    if (!room || this._loadingOlder()) {
      return of(void 0);
    }
    return defer(() => {
      this._loadingOlder.set(true);
      return from(this.matrix.instance.scrollback(room, SCROLLBACK));
    }).pipe(
      tap(() => this.refresh()),
      // Reset the flag on success *or* error — otherwise a failed scrollback
      // would leave it stuck true and permanently disable pagination.
      finalize(() => this._loadingOlder.set(false)),
      map(() => void 0),
    );
  }

  /**
   * The open room plus the *currently active* account's client, or null when either
   * is unavailable. Every cold action below resolves this inside its `defer()` — i.e.
   * on subscribe, never when the Observable is merely constructed. `matrix.instance`
   * follows the active account, and `this.room` follows navigation, so capturing
   * either eagerly would let a held (or retried) action fire against an account the
   * user has switched away from, or a room they have left.
   */
  private context(): { client: MatrixClient; room: Room } | null {
    const room = this.room;
    if (!room || !this.matrix.isInitialized) {
      return null;
    }
    return { client: this.matrix.instance, room };
  }

  /**
   * Broadcast whether the local user is typing in the open room. Fire-and-forget:
   * the composer calls this on input (start) and on send/close (stop). Starts are
   * throttled to one `sendTyping(true)` per {@link TYPING_REFRESH_MS} — the server
   * keeps the flag alive for {@link TYPING_TIMEOUT_MS}, so it never lapses mid-compose
   * yet we don't hit the network on every keystroke. A no-op when no room is open.
   */
  setTyping(typing: boolean): void {
    const ctx = this.context();
    if (!ctx) {
      return;
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

  /** Re-read the open room's typing set into `typingNames`, excluding the local user. */
  private refreshTyping(): void {
    const ctx = this.context();
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
    if (!this.matrix.isInitialized) {
      return null;
    }
    const event = this.matrix.instance.getRoom(roomId)?.findEventById(eventId);
    return event?.getEffectiveEvent() ?? null;
  }

  /**
   * Send a message to the active room. Markdown is rendered to HTML, sanitized,
   * and sent as `formatted_body` — but only when it actually adds formatting; plain
   * text is sent as-is. The local echo appears via the timeline listener.
   */
  send(body: string, mentions: Mention[] = []): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const ctx = this.context();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room } = ctx;
      // A leading slash command (/me, /shrug, /plain, /spoiler) rewrites the content;
      // otherwise build the normal text content (rather than sendText/HtmlMessage) so
      // mentions carry `m.mentions` + matrix.to pills. The SDK creates the local echo.
      const content =
        slashCommandContent(text, renderMarkdown, mentions) ??
        textMessageContent(text, renderMarkdown(text), mentions);
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Send a shared location (`m.location`) to the active room. Cold — runs on subscribe. */
  sendLocation(lat: number, lng: number): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx) {
        return of(void 0);
      }
      const { client, room } = ctx;
      return from(
        client.sendMessage(
          room.roomId,
          locationMessageContent(lat, lng) as never,
        ),
      ).pipe(map(() => void 0));
    });
  }

  /**
   * Upload a recorded clip and send it as an MSC3245 voice message (an `m.audio`
   * with the voice marker + waveform), encrypting the bytes first in an E2EE room.
   * Cold — runs on subscribe.
   */
  sendVoiceMessage(recording: VoiceRecording): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx || recording.blob.size === 0) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const encrypt = room.hasEncryptionStateEvent();
      const file = new File(
        [recording.blob],
        `voice-message.${voiceExtension(recording.mimeType)}`,
        { type: recording.mimeType },
      );
      return this.mediaSvc.uploadMedia(file, encrypt).pipe(
        switchMap((media) =>
          from(
            client.sendMessage(
              room.roomId,
              voiceMessageContent(
                {
                  mxc: media.mxc,
                  file: media.file,
                  mimeType: media.info.mimetype,
                  size: media.info.size,
                },
                recording.durationMs,
                recording.waveform,
              ) as never,
            ),
          ),
        ),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Forward a message to another room: copy its content — dropping any reply/edit/thread
   * relation so it lands as a standalone message — and send it there. Works across rooms
   * and for media (an encrypted attachment carries its own key in the content, so the
   * target room's members can still decrypt it). Cold: runs on subscribe.
   */
  forwardMessage(
    sourceRoomId: string,
    eventId: string,
    targetRoomId: string,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      const event = client.getRoom(sourceRoomId)?.findEventById(eventId);
      if (!event) {
        return throwError(() => new Error('Message not found.'));
      }
      const content = { ...event.getContent() };
      delete content['m.relates_to'];
      delete content['m.new_content'];
      return from(client.sendMessage(targetRoomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Start a single-select poll (MSC3381) in the open room. Cold: runs on subscribe. */
  createPoll(question: string, options: string[]): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      const clean = options.map((o) => o.trim()).filter(Boolean);
      if (!ctx || !question.trim() || clean.length < 2) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          'm.poll.start' as never,
          pollStartContent(question.trim(), clean) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Everyone who reacted to `eventId`, grouped by reaction key — the full list behind
   * the pills' capped "reacted by …" hint, read on demand when the who-reacted dialog
   * opens. `findEventById` also searches the room's thread timelines, so this serves a
   * thread row as well (like {@link votePoll}). Empty when the room isn't open or the
   * event isn't loaded; a snapshot, not a live signal.
   */
  reactionDetails(eventId: string): ReactionDetail[] {
    const ctx = this.context();
    const event = ctx?.room.findEventById(eventId);
    if (!ctx || !event) {
      return [];
    }
    return reactionDetailsFor(ctx.client, ctx.room, event);
  }

  /** Cast (or change) the local user's vote on a poll. Cold: runs on subscribe. */
  votePoll(pollId: string, answerId: string): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          'm.poll.response' as never,
          pollResponseContent(pollId, answerId) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /** Close a poll so no further votes count (creator action). Cold: runs on subscribe. */
  endPoll(pollId: string): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          'm.poll.end' as never,
          pollEndContent(pollId) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Upload a picked file and send it as an `m.image`/`m.file`/`m.video`/`m.audio`
   * message — encrypting the bytes first when the room is E2EE. The upload phase has
   * no echo (failures surface via this Observable); once `sendMessage` runs the SDK
   * creates a local echo that renders through the existing media bubble, with the
   * usual failed/retry handling. `progress` reports an upload fraction in [0, 1].
   */
  sendMedia(
    file: File,
    caption: string,
    progress?: (fraction: number) => void,
  ): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx || !file || file.size === 0) {
        return of(void 0);
      }
      const { client, room } = ctx;
      // Read on subscribe too: a room can become encrypted while an unsent action
      // is held, and uploading plaintext bytes into an E2EE room is not recoverable.
      const encrypt = room.hasEncryptionStateEvent();
      return this.mediaSvc.uploadMedia(file, encrypt, progress).pipe(
        switchMap((media) => {
          const content = {
            msgtype: media.msgtype,
            ...mediaCaptionFields(media.body, caption),
            info: media.info,
            ...(media.file ? { file: media.file } : { url: media.mxc }),
          };
          // A valid media payload; the SDK's content union doesn't model it.
          return from(client.sendMessage(room.roomId, content as never));
        }),
      );
    }).pipe(map(() => void 0));
  }

  /** Edit a previously-sent message via an `m.replace` relation. */
  edit(
    messageId: string,
    newBody: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = newBody.trim();
    return defer(() => {
      const ctx = this.context();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const content = editMessageContent(
        messageId,
        text,
        renderMarkdown(text),
        mentions,
      );
      // `content` is a valid m.replace payload; the SDK's content union doesn't
      // model it, so assert past it.
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Resend a message that failed to send. */
  retry(messageId: string): void {
    const room = this.room;
    if (!room || !this.matrix.isInitialized) {
      return;
    }
    const event = room
      .getLiveTimeline()
      .getEvents()
      .find((e) => e.getId() === messageId);
    if (event) {
      this.matrix.instance.resendEvent(event, room).catch(() => undefined);
    }
  }

  /** Send a reply to a message (`m.in_reply_to`), with a plain-text quote fallback. */
  reply(
    messageId: string,
    body: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const ctx = this.context();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const content = replyMessageContent(
        room,
        messageId,
        text,
        renderMarkdown(text),
        mentions,
      );
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Delete (redact) a message. */
  redact(messageId: string): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx) {
        return of(void 0);
      }
      return from(ctx.client.redactEvent(ctx.room.roomId, messageId));
    }).pipe(map(() => void 0));
  }

  /**
   * Toggle the current user's reaction to a message: add the `m.annotation` if it
   * isn't there yet, otherwise redact their existing one.
   */
  toggleReaction(messageId: string, key: string): Observable<void> {
    return defer(() => {
      const ctx = this.context();
      if (!ctx) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const mine = myReactionId(client, room, messageId, key);
      if (mine) {
        return from(client.redactEvent(room.roomId, mine));
      }
      return from(
        client.sendEvent(
          room.roomId,
          EventType.Reaction,
          annotationContent(messageId, key) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  private refresh(): void {
    const room = this.room;
    if (!room) {
      return;
    }
    const client = this.matrix.instance;
    const liveTimeline = room.getLiveTimeline();
    const events = liveTimeline.getEvents();
    const seen = new Set<string>();
    const relevant = new Set<string>();
    // Divider anchor: the first surviving message after the read marker that someone else
    // sent. The "after the marker" test runs on the RAW event order — markRead acks the
    // newest raw event, so m.fully_read can name an event the projection drops (a hidden
    // system line, but also a reaction, an edit or a pin). Deriving it from the projected
    // list would find nothing and silently take the divider with it.
    const marker = this._readMarker();
    const markerIdx = marker
      ? events.findIndex((e) => e.getId() === marker)
      : -1;
    const afterMarker =
      markerIdx >= 0
        ? new Set(events.slice(markerIdx + 1).map((e) => e.getId() ?? ''))
        : null;
    let firstUnread: string | null = null;
    const views = events
      // Edit events (m.replace) are aggregated onto their target, so hide them.
      // Threaded replies (`threadRootId` set on a non-root) are projected by
      // ThreadsService instead — the SDK already keeps them out of the live
      // timeline when thread support is on, but guard here too in case any leak.
      // Membership / room-state changes ride alongside messages as system lines.
      .filter(
        (e) =>
          !isThreadReply(e) &&
          (isDisplayableMessage(e) || isDisplayableStateEvent(e)),
      )
      .map((e): MessageView | null => {
        const id = e.getId() ?? '';
        // A state / membership change → a compact "system" line. The summary fully
        // determines the row, so it doubles as the cache rev (and re-derives on a late
        // display-name resolution); a no-op change (null) is dropped entirely.
        if (!isDisplayableMessage(e)) {
          const line = describeTimelineEvent(e, room);
          // Dropped when there is nothing to say (a no-op change) or when the user has
          // hidden this category. Returning null collapses the row entirely — no gap or
          // placeholder — and keeps `seen` clean so the view cache prunes it.
          if (!line || !this.showsCategory(line.category)) {
            return null;
          }
          const summary = line.text;
          seen.add(id);
          collectMessageSenders(client, room, e, relevant);
          // A membership line names the TARGET (state_key), whose display name can
          // load late — register them too so a RoomStateEvent.Members for that member
          // re-projects the line (same late-member fix as reply previews).
          const target = e.getStateKey();
          if (e.getType() === EventType.RoomMember && target) {
            relevant.add(target);
          }
          const cached = this.viewCache.get(id);
          if (cached && cached.rev === summary) {
            return cached.view;
          }
          const view = buildTimelineEventView(client, room, e, summary);
          this.viewCache.set(id, { rev: summary, view });
          return view;
        }
        seen.add(id);
        collectMessageSenders(client, room, e, relevant);
        // A system line is not an unread *message*, so only real messages from someone else
        // can anchor the divider.
        if (
          afterMarker?.has(id) &&
          !firstUnread &&
          e.getSender() !== client.getUserId()
        ) {
          firstUnread = id;
        }
        // Reuse the existing view (preserving its object identity for OnPush)
        // unless something this event renders from has actually changed. The shield
        // (resolved asynchronously) is folded into the rev so a trust change re-projects.
        const shield = this.shields.get(id) ?? null;
        const rev = eventRevision(client, room, e) + '\x1f' + shieldKey(shield);
        const cached = this.viewCache.get(id);
        if (cached && cached.rev === rev) {
          return cached.view;
        }
        const view = safeBuildMessageView(client, room, e, shield);
        this.viewCache.set(id, { rev, view });
        return view;
      })
      .filter((view): view is MessageView => view !== null);
    this.relevantSenders = relevant;
    this._oldestEventId.set(events[0]?.getId() ?? null);
    // Null when there is no marker, the marker isn't loaded, or nothing followed it.
    this._firstUnreadId.set(afterMarker ? firstUnread : null);
    // Drop cache entries for events no longer in the timeline (redacted-away,
    // replaced by their remote id, or scrolled out under a window cap). Prune the
    // shields map on the same key set so it can't grow unbounded across a session.
    for (const id of [...this.viewCache.keys()]) {
      if (!seen.has(id)) {
        this.viewCache.delete(id);
      }
    }
    for (const id of [...this.shields.keys()]) {
      if (!seen.has(id)) {
        this.shields.delete(id);
      }
    }
    this._messages.set(views);
    // Resolve encrypted-message authenticity shields off the async crypto API; when any
    // resolve to a new value they're folded into the cache rev and re-projected.
    void this.resolveShields(room, events);
    this._canLoadOlder.set(
      liveTimeline.getPaginationToken(Direction.Backward) !== null,
    );
    // The room is on-screen: mark its latest message read while the window is
    // focused (deduped, so live messages clear the badge but paginating older
    // history doesn't re-send). Skipped while unfocused so an open room still
    // shows unread; onFocus re-acks on return.
    this.markRead(events);
    // A tombstone lands as a state event → onTimeline → here; keep the banner current.
    this.updateTombstone(room);
  }

  /**
   * Recompute the open room's tombstone (successor room). Cheap, and guarded so an
   * unchanged tombstone doesn't churn the signal (and re-render the banner) each refresh.
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
   * API, storing them per event id. When any shield actually changes it triggers one more
   * {@link refresh} (whose rev now differs, so only the changed rows rebuild) — which
   * re-enters here, finds nothing new, and stops. Best-effort: a room switch mid-resolve
   * or a missing crypto API bails without touching state.
   */
  private async resolveShields(
    room: Room,
    events: readonly MatrixEvent[] = room.getLiveTimeline().getEvents(),
    force = false,
  ): Promise<void> {
    const crypto = this.matrix.isInitialized
      ? (this.matrix.instance.getCrypto?.() ?? null)
      : null;
    if (!crypto) {
      return;
    }
    const encrypted = events.filter(
      (e) => isDisplayableMessage(e) && !isThreadReply(e) && e.isEncrypted(),
    );
    const changed = await resolveShieldsInto(crypto, encrypted, this.shields, {
      force,
      isStale: () => this.roomId !== room.roomId,
    });
    if (changed && this.roomId === room.roomId) {
      this.refresh();
    }
  }

  /**
   * Send a read receipt for the active room's latest *confirmed* event, clearing
   * its unread badge — but ONLY while the window is focused. When the app isn't in
   * focus we skip the ack, so an open room still accumulates unread (the badge
   * climbs like any other channel); {@link onFocus} re-acks when focus returns.
   * Deduped on the last-acked event id so a live message marks read but a no-op
   * refresh (decryption, pagination) doesn't re-send. Pending local echoes are
   * skipped (the SDK rejects a receipt on an unsent event) and any missing/failed
   * receipt API is swallowed so viewing a room never throws. `events` defaults to
   * the live timeline so the focus re-ack can run without a refresh's snapshot.
   */
  private markRead(events?: readonly MatrixEvent[]): void {
    if (!this.matrix.isInitialized || !this.room) {
      return;
    }
    // The room is open, but the user isn't looking if the window is unfocused —
    // hold the receipt so its unread accumulates; onFocus re-acks on return.
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      return;
    }
    const list = events ?? this.room.getLiveTimeline().getEvents();
    const latest = [...list].reverse().find((e) => !e.status);
    const id = latest?.getId() ?? null;
    if (!latest || !id || id === this.lastReadEventId) {
      return;
    }
    this.lastReadEventId = id;
    try {
      // When the user has turned off read receipts, still ack — but privately
      // (`m.read.private`), so their unread badge clears without other users
      // seeing that they read it.
      const receiptType = this.privacy.sendReadReceipts()
        ? ReceiptType.Read
        : ReceiptType.ReadPrivate;
      void this.matrix.instance
        .sendReadReceipt(latest, receiptType)
        ?.catch(() => undefined);
      // Also advance the persisted fully-read marker so the unread anchor survives
      // reloads and other devices (the divider reads it on the next open).
      void this.matrix.instance
        .setRoomReadMarkers(this.room.roomId, id)
        ?.catch(() => undefined);
    } catch {
      // A missing/unsupported receipt API must never break room viewing.
    }
  }

  /** The room's persisted fully-read marker event id (`m.fully_read`), or null. */
  private readMarkerOf(room: Room): string | null {
    const content = room.getAccountData?.(EventType.FullyRead)?.getContent();
    const eventId = content?.['event_id'];
    return typeof eventId === 'string' ? eventId : null;
  }
}

/**
 * True for a threaded reply that should live only in its thread, not the main
 * timeline: it carries a thread root id but is not itself the thread root. (A
 * plain `m.in_reply_to` reply has no `threadRootId`, so it stays in the timeline.)
 */
function isThreadReply(event: MatrixEvent): boolean {
  return event.threadRootId !== undefined && !event.isThreadRoot;
}

/**
 * A compact fingerprint of every per-event input {@link buildMessageView} reads
 * that can change while the room is open: send status, redaction, decryption,
 * edits (captured via the effective content + replacing-event presence),
 * aggregated reactions, the reply preview (see {@link replyTargetSignature}), and
 * the sender's resolved name/avatar. The projection rebuilds a view only when this
 * changes, so an unchanged message keeps its existing object and its OnPush row
 * is never touched.
 */
export function eventRevision(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string {
  const senderId = event.getSender() ?? '';
  const member = room.getMember(senderId);
  return [
    event.status ?? '',
    event.isRedacted() ? 'r' : '',
    event.isDecryptionFailure() ? 'd' : '',
    event.replacingEvent() ? 'e' : '',
    // Effective content captures edits (m.replace) and decrypted bodies; it is far
    // cheaper than the DOMPurify pass that a rebuild would otherwise repeat.
    JSON.stringify(event.getContent()),
    reactionSignature(client, room, event),
    replyTargetSignature(room, event.replyEventId),
    member?.name ?? senderId,
    member?.getMxcAvatarUrl() ?? '',
    // Re-project when the "seen by" receipts on this event change.
    receiptSignature(client, room, event),
    // Re-project a poll when its votes or end state change.
    isPollStart(event) ? pollSignature(room, event) : '',
  ].join('\x1f');
}

/**
 * Signature of the "seen by" receipts for {@link eventRevision}: who has read up to
 * this event, and — like the sender and the quoted reply target — each reader's
 * resolved name and avatar.
 *
 * The ids alone are not enough. A reader whose profile arrives late (or who sets an
 * avatar for the first time) produces an identical id list, so the memoised view is
 * returned verbatim and their receipt keeps showing a coloured initial while the same
 * person renders correctly everywhere else.
 */
function receiptSignature(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string {
  return readReceiptsFor(client, room, event)
    .map((receipt) =>
      [receipt.userId, receipt.name, receipt.avatarMxc ?? ''].join('\x03'),
    )
    .join(',');
}

/**
 * Signature of a reply's quoted target for {@link eventRevision}: empty when the
 * event isn't a reply, `'n'` while the target isn't loaded (no preview yet), else
 * its redaction, body, and — crucially — the quoted sender's resolved name +
 * avatar. Including the latter re-projects the preview when the quoted member's
 * profile arrives late (lazy loading), so it stops showing the raw mxid + initials.
 */
function replyTargetSignature(room: Room, replyId: string | undefined): string {
  if (!replyId) {
    return '';
  }
  const target = room.findEventById(replyId);
  if (!target) {
    return 'n';
  }
  const sender = target.getSender() ?? '';
  const member = room.getMember(sender);
  return [
    'y',
    target.isRedacted() ? 'r' : '',
    String(target.getContent()['body'] ?? ''),
    member?.name || sender,
    member?.getMxcAvatarUrl() ?? '',
  ].join('\x02');
}

/**
 * Stable signature of an event's aggregated reactions (key, count, own flag) — plus
 * the reactor names the pill shows. Those names resolve late (lazy member loading),
 * and without them in the fingerprint the cached view is reused verbatim and the
 * pill keeps naming a raw mxid; same reasoning as {@link replyTargetSignature}. The
 * list is capped at projection time (`MAX_NAMED_REACTORS`), which is what keeps this
 * bounded on a heavily-reacted message.
 */
function reactionSignature(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string {
  return reactionsFor(client, room, event)
    .map(
      (r) =>
        `${r.key}:${r.count}:${r.reacted ? 1 : 0}:${r.reactors.join('\x03')}`,
    )
    .join(',');
}
