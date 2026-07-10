import { Injectable, computed, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  Direction,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
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
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { MediaService } from '@trinity/data-access-media';
import {
  annotationContent,
  buildMessageView,
  collectMessageSenders,
  editMessageContent,
  isDisplayableMessage,
  isPollStart,
  pollSignature,
  pollStartContent,
  pollResponseContent,
  pollEndContent,
  mediaCaptionFields,
  myReactionId,
  reactionsFor,
  readReceiptUserIds,
  renderMarkdown,
  replyMessageContent,
  textMessageContent,
  TYPING_REFRESH_MS,
  TYPING_TIMEOUT_MS,
  type MessageView,
  type Mention,
} from '@trinity/util-matrix';

const SCROLLBACK = 30;

/**
 * Projects the *active* room's live timeline into a `messages` signal of view
 * models. Re-maps on new events and on async E2EE decryption. The shell opens one
 * room at a time; `matrix-js-sdk` remains the source of truth.
 *
 * With thread support enabled on the client (see {@link MatrixClientService}), the
 * SDK routes threaded replies into per-thread timelines, so they are absent from
 * the room's live timeline here — only thread *roots* remain in the main view. The
 * thread roots and their replies are projected separately by `ThreadsService`.
 */
@Injectable({ providedIn: 'root' })
export class TimelineService {
  private readonly matrix = inject(MatrixClientService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly mediaSvc = inject(MediaService);

  private readonly _messages = signal<MessageView[]>([]);
  readonly messages = this._messages.asReadonly();

  private readonly _loadingOlder = signal(false);
  readonly loadingOlder = this._loadingOlder.asReadonly();

  private readonly _canLoadOlder = signal(false);
  readonly canLoadOlder = this._canLoadOlder.asReadonly();

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

  // Timestamp (ms) of the last `sendTyping(true)` we issued for the open room, so we
  // refresh the flag at most every {@link TYPING_REFRESH_MS} instead of per keystroke;
  // 0 means we are not currently marked as typing.
  private typingSentAt = 0;

  private roomId: string | null = null;

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
   * Event id of the first unread message: the message right after the on-open
   * {@link _readMarker} that isn't the user's own. Drives the "New messages" divider
   * and the jump-to-unread control. Null when nothing is unread (or the marker isn't a
   * loaded message).
   */
  readonly firstUnreadId = computed<string | null>(() => {
    const marker = this._readMarker();
    if (!marker) {
      return null;
    }
    const msgs = this._messages();
    const markerIdx = msgs.findIndex((m) => m.id === marker);
    if (markerIdx < 0) {
      return null; // the marker isn't among the loaded messages — no divider
    }
    for (let i = markerIdx + 1; i < msgs.length; i++) {
      if (!msgs[i].isOwn) {
        return msgs[i].id; // first message after the marker that someone else sent
      }
    }
    return null;
  });

  // User ids the current projection renders a member for: every message's sender
  // (its header) plus every reply's quoted sender (its preview). Recomputed each
  // refresh; the member listener re-projects only when one of *these* members
  // loads/changes, so a full lazy member-load doesn't re-map once per member.
  private relevantSenders = new Set<string>();

  private readonly onTimeline = (): void => this.refresh();
  private readonly onLocalEcho = (): void => this.refresh();
  // Others' read receipts moved — re-project so the "seen by" avatars follow them.
  private readonly onReceipt = (): void => this.refresh();
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.refresh();
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
      this.refresh();
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
    room.on(RoomEvent.Timeline, this.onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, this.onLocalEcho);
    room.on(RoomEvent.Receipt, this.onReceipt);
    room.on(RoomStateEvent.Members, this.onMember);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    client.on(RoomMemberEvent.Typing, this.onTyping);
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
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(MatrixEventEvent.Decrypted, this.onDecrypted);
      this.matrix.instance.off(RoomMemberEvent.Typing, this.onTyping);
    }
    this.room = null;
    this.roomId = null;
    this.lastReadEventId = null;
    this._readMarker.set(null);
    this.relevantSenders.clear();
    this.viewCache.clear();
    this._messages.set([]);
    this._typingNames.set([]);
    this._canRedactOthers.set(false);
    this._canLoadOlder.set(false);
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
      room.currentState?.hasSufficientPowerLevelFor?.('redact', level) ?? false,
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
      // Build the content (rather than sendText/HtmlMessage) so mentions carry
      // `m.mentions` + matrix.to pills. The SDK still creates the local echo.
      const content = textMessageContent(
        text,
        renderMarkdown(this.sanitizer, text),
        mentions,
      );
      return from(client.sendMessage(room.roomId, content as never));
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
            ...mediaCaptionFields(this.sanitizer, media.body, caption),
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
        renderMarkdown(this.sanitizer, text),
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
        renderMarkdown(this.sanitizer, text),
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
    const views = events
      // Edit events (m.replace) are aggregated onto their target, so hide them.
      // Threaded replies (`threadRootId` set on a non-root) are projected by
      // ThreadsService instead — the SDK already keeps them out of the live
      // timeline when thread support is on, but guard here too in case any leak.
      .filter((e) => isDisplayableMessage(e) && !isThreadReply(e))
      .map((e) => {
        const id = e.getId() ?? '';
        seen.add(id);
        collectMessageSenders(room, e, relevant);
        // Reuse the existing view (preserving its object identity for OnPush)
        // unless something this event renders from has actually changed.
        const rev = eventRevision(client, room, e);
        const cached = this.viewCache.get(id);
        if (cached && cached.rev === rev) {
          return cached.view;
        }
        const view = buildMessageView(client, room, e);
        this.viewCache.set(id, { rev, view });
        return view;
      });
    this.relevantSenders = relevant;
    // Drop cache entries for events no longer in the timeline (redacted-away,
    // replaced by their remote id, or scrolled out under a window cap).
    for (const id of [...this.viewCache.keys()]) {
      if (!seen.has(id)) {
        this.viewCache.delete(id);
      }
    }
    this._messages.set(views);
    this._canLoadOlder.set(
      liveTimeline.getPaginationToken(Direction.Backward) !== null,
    );
    // The room is on-screen: mark its latest message read while the window is
    // focused (deduped, so live messages clear the badge but paginating older
    // history doesn't re-send). Skipped while unfocused so an open room still
    // shows unread; onFocus re-acks on return.
    this.markRead(events);
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
      void this.matrix.instance.sendReadReceipt(latest)?.catch(() => undefined);
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
function eventRevision(
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
    readReceiptUserIds(client, room, event).join(','),
    // Re-project a poll when its votes or end state change.
    isPollStart(event) ? pollSignature(room, event) : '',
  ].join('\x1f');
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

/** Stable signature of an event's aggregated reactions (key, count, own flag). */
function reactionSignature(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string {
  return reactionsFor(client, room, event)
    .map((r) => `${r.key}:${r.count}:${r.reacted ? 1 : 0}`)
    .join(',');
}
