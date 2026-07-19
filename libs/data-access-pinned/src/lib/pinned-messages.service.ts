import { Injectable, computed, inject, signal } from '@angular/core';
import {
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, of, tap } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { liveRoomState, messagePreview } from '@trinity/util-matrix';

/**
 * A compact, render-ready projection of one pinned message — the pinned panel's row
 * model. Resolved from the room's locally-loaded timeline; no SDK types leak out.
 */
export interface PinnedMessageView {
  /** The pinned event's id. */
  id: string;
  /** Raw sender mxid (fallback display when no member profile is loaded). */
  sender: string;
  /** Resolved display name of the sender, falling back to the mxid. */
  senderName: string;
  /** Short, single-line plain-text preview of the message. */
  body: string;
  /** Origin-server timestamp of the pinned event. */
  ts: number;
}

/**
 * Projects a room's `m.room.pinned_events` state (the array of pinned event ids)
 * into render-ready signals for the *active* room — mirroring
 * {@link TimelineService}/{@link ThreadsService}'s instance-keyed open/close
 * lifecycle and gated-listener discipline (attach on open, detach on close).
 *
 * The backing store is the `m.room.pinned_events` state event (state key `''`),
 * whose content is `{ pinned: string[] }` (order = pin order). Pinning appends an id
 * and unpinning filters it out, then rewrites the whole array via
 * {@link MatrixClient.sendStateEvent}. Permission is gated on
 * `maySendStateEvent(EventType.RoomPinnedEvents, …)`.
 *
 * Live updates: a single {@link RoomStateEvent.Events} listener on the *room* fires
 * for every state event, so filtering to `m.room.pinned_events` (remote pins) and
 * `m.room.power_levels` (permission changes) keeps both {@link pinnedEventIds} and
 * {@link canPin} reactive. The room re-emits the RoomState events, which is what makes
 * it safe to bind here rather than to `room.currentState` — that reference is replaced
 * on a live-timeline reset. The SDK event handlers write signals, which schedule change
 * detection on their own.
 *
 * Preview resolution is best-effort and synchronous: each pinned id is resolved
 * against the room's locally-loaded events (`room.findEventById`). A pin that isn't
 * loaded yet, or that resolves to a redacted event, is dropped from
 * {@link pinnedMessages} rather than fetched — the `Timeline`/`Decrypted` listeners
 * bump a revision so a pin resolves as its event later loads or decrypts.
 */
@Injectable({ providedIn: 'root' })
export class PinnedMessagesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _pinnedEventIds = signal<string[]>([]);
  /** The active room's pinned event ids, in pin order. */
  readonly pinnedEventIds = this._pinnedEventIds.asReadonly();

  private readonly _canPin = signal(false);
  /** Whether the current user may pin/unpin in the active room. */
  readonly canPin = this._canPin.asReadonly();

  // Bumped when the timeline changes or an event decrypts, so the derived
  // pinnedMessages re-resolves previews as pinned events load/decrypt late.
  private readonly _revision = signal(0);

  /**
   * The pinned messages as render-ready view models, resolving each id against the
   * room's locally-loaded events. Missing (not-yet-loaded) or redacted pins are
   * skipped — a best-effort, synchronous resolve.
   */
  readonly pinnedMessages = computed<PinnedMessageView[]>(() => {
    this._revision();
    const ids = this._pinnedEventIds();
    const room = this.room;
    if (!room) {
      return [];
    }
    const views: PinnedMessageView[] = [];
    for (const id of ids) {
      const event = room.findEventById(id);
      if (!event || event.isRedacted()) {
        continue;
      }
      const sender = event.getSender() ?? '';
      views.push({
        id,
        sender,
        senderName: room.getMember(sender)?.name ?? sender,
        body: messagePreview(event),
        ts: event.getTs(),
      });
    }
    return views;
  });

  private roomId: string | null = null;
  private room: Room | null = null;

  /**
   * The client {@link open} attached its Decrypted listener to. `matrix.instance`
   * follows the ACTIVE account, so re-reading it in {@link close} after an account
   * switch would detach from the *new* client and leak the listener on the old one.
   */
  private connectedClient: MatrixClient | null = null;

  // A state event of any type; filter to pinned-events + power-levels. The re-read
  // writes signals, which schedule change detection.
  private readonly onStateEvent = (event: MatrixEvent): void => {
    const type = event.getType();
    if (
      type === EventType.RoomPinnedEvents ||
      type === EventType.RoomPowerLevels
    ) {
      this.readRoomState();
    }
  };
  // A pinned event may decrypt after its id is pinned; bump the revision so its
  // preview resolves once the plaintext is available.
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this._revision.update((n) => n + 1);
    }
  };
  // A pinned event may load via pagination/backfill after it was pinned; bump so its
  // preview resolves once the event is in the timeline.
  private readonly onTimeline = (): void => this._revision.update((n) => n + 1);

  /** Start projecting a room's pinned messages; attaches live listeners. */
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
    // A single state listener covers both remote pin changes and power-level
    // (permission) changes. Bind it to the ROOM, not to `room.currentState`: that is a
    // cached reference the SDK swaps out whenever the live timeline is reset, re-pointing
    // its re-emission at the replacement — so a listener held on the old object would go
    // deaf and outlive close(). The room re-emits RoomStateEvent.* for exactly this reason.
    room.on(RoomStateEvent.Events, this.onStateEvent);
    room.on(RoomEvent.Timeline, this.onTimeline);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    this.readRoomState();
  }

  /** Detach listeners and clear the pinned state. */
  close(): void {
    this.room?.off(RoomStateEvent.Events, this.onStateEvent);
    this.room?.off(RoomEvent.Timeline, this.onTimeline);
    // Detach from the client open() attached to, not `matrix.instance` — that follows
    // the active account and would leak this listener on the old client after a switch.
    this.connectedClient?.off(MatrixEventEvent.Decrypted, this.onDecrypted);
    this.connectedClient = null;
    this.room = null;
    this.roomId = null;
    this._pinnedEventIds.set([]);
    this._canPin.set(false);
    this._revision.set(0);
  }

  /** Whether `eventId` is currently pinned in the active room. */
  isPinned(eventId: string): boolean {
    return this._pinnedEventIds().includes(eventId);
  }

  /**
   * Pin a message: append its id to the pinned array and persist. The returned
   * action is cold — subscribe to run it (a no-op success if already pinned), so
   * the caller can surface success/failure. Errors propagate to the subscriber.
   */
  pin(eventId: string): Observable<void> {
    const current = this._pinnedEventIds();
    if (current.includes(eventId)) {
      return of(void 0);
    }
    return this.write([...current, eventId]);
  }

  /**
   * Unpin a message: filter its id out of the pinned array and persist. Cold —
   * subscribe to run it; errors propagate to the subscriber.
   */
  unpin(eventId: string): Observable<void> {
    return this.write(this._pinnedEventIds().filter((id) => id !== eventId));
  }

  /**
   * Rewrite the room's `m.room.pinned_events` state with `pinned` as a cold action.
   * The state listener refreshes on the sync echo, but re-read on success too so the
   * local change lands immediately; a send failure surfaces to the subscriber.
   */
  private write(pinned: string[]): Observable<void> {
    return defer(() => {
      const room = this.room;
      if (!room || !this.matrix.isInitialized) {
        return of(void 0);
      }
      return from(
        // Resolved on subscribe: `instance` follows the active account.
        this.matrix.instance.sendStateEvent(
          room.roomId,
          EventType.RoomPinnedEvents,
          { pinned },
          '',
        ),
      ).pipe(
        tap(() => this.readRoomState()),
        map(() => void 0),
      );
    });
  }

  /** Re-read the pinned ids and pin permission from the room's current state. */
  private readRoomState(): void {
    const room = this.room;
    if (!room || !this.matrix.isInitialized) {
      return;
    }
    const state = liveRoomState(room);
    const pinned =
      state
        ?.getStateEvents(EventType.RoomPinnedEvents, '')
        ?.getContent<{ pinned?: string[] }>().pinned ?? [];
    this._pinnedEventIds.set([...pinned]);
    const userId = this.matrix.instance.getUserId();
    this._canPin.set(
      !!userId &&
        !!state?.maySendStateEvent(EventType.RoomPinnedEvents, userId),
    );
  }
}
