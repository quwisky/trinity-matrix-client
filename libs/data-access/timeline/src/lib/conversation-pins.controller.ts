import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import {
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { catchError, defer, from, map, of, type Observable } from 'rxjs';
import { coalesce } from '@trinity/data-access/matrix-client';
import { latestGuard } from '@trinity/util/ui';
import {
  isTransientMatrixError,
  liveRoomState,
  messagePreview,
  RoomEncryptionFlags,
} from '@trinity/util/matrix';
import { unencryptedShieldFor } from './shields';
import type { ConversationKey } from './conversation-messages';
import type {
  ConversationPinOperation,
  ConversationPinOutcome,
  ConversationPinPolicy,
  ConversationPins,
  PinnedMessageView,
} from './conversation-pins';

type PinFetch =
  | { readonly kind: 'loaded'; readonly event: MatrixEvent }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly at: number };

/** Minimum gap before a Timeline or Decrypted event retries a failed pin again. */
const AUTO_RETRY_MS = 30_000;

/** Pins read from room state; earlier ids are ignored so one event cannot fan out unbounded fetches. */
const MAX_PINS = 100;
const MAX_CONCURRENT_PIN_FETCHES = 4;

const unavailablePolicy: ConversationPinPolicy = {
  canMutate: () => false,
  authorize: () => ({
    kind: 'rejected',
    failure: 'conversation-unavailable',
  }),
};

export const CONVERSATION_PIN_POLICY =
  new InjectionToken<ConversationPinPolicy>(
    'conversation-runtime.room-administration-pin-policy',
    { providedIn: 'root', factory: () => unavailablePolicy },
  );

/** Package-internal exact-Conversation projection of authoritative pinned-room state. */
@Injectable()
export class ConversationPinsController implements ConversationPins {
  private readonly policy = inject(CONVERSATION_PIN_POLICY);
  private readonly pinnedEventIds = signal<readonly string[]>([]);
  /** The room's `pinned` array exactly as read, so writes keep entries the display list drops. */
  private rawPinned: readonly unknown[] = [];
  private readonly pinnedMessages = signal<readonly PinnedMessageView[]>([]);
  private readonly mayMutate = signal(false);
  /** Pins fetched because the loaded timeline lacks them. */
  private fetched = new Map<string, PinFetch>();
  private loading = new Set<string>();
  /** Pins waiting for a free fetch slot; `loading` already holds them. */
  private queued: string[] = [];
  /** A slot frees when its request settles, even after a release or room switch. */
  private activeFetches = 0;
  /** Invalidated when the pin list or room changes, so in-flight fetches drop their results. */
  private readonly fetches = latestGuard();
  private fetchToken = this.fetches.next();
  private key: ConversationKey | null = null;
  private room: Room | null = null;
  private client: MatrixClient | null = null;
  private encryption = new RoomEncryptionFlags();

  readonly eventIds = this.pinnedEventIds.asReadonly();
  readonly messages = this.pinnedMessages.asReadonly();
  readonly canMutate = this.mayMutate.asReadonly();

  private readonly scheduleResolve = coalesce(() => this.resolvePinned());
  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (
      event.getType() === EventType.RoomPinnedEvents ||
      event.getType() === EventType.RoomPowerLevels
    ) {
      this.readRoomState();
    }
  };
  private readonly onTimeline = (): void => {
    this.retryFailedPins(AUTO_RETRY_MS);
    this.scheduleResolve.schedule();
  };
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.key?.roomId) {
      this.retryFailedPins(AUTO_RETRY_MS);
      this.scheduleResolve.schedule();
    }
  };

  attach(key: ConversationKey, client: MatrixClient): void {
    this.release();
    const room = client.getRoom(key.roomId);
    if (!room || client.getUserId() !== key.accountId) return;
    this.key = Object.freeze({ ...key });
    this.room = room;
    this.client = client;
    this.encryption = new RoomEncryptionFlags();
    void this.encryption
      .refresh(client.getCrypto?.(), room.roomId)
      .then((encrypted) => {
        if (encrypted && this.room === room) this.scheduleResolve.schedule();
      });
    room.on(RoomStateEvent.Events, this.onStateEvent);
    room.on(RoomEvent.Timeline, this.onTimeline);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    try {
      this.readRoomState();
    } catch (error) {
      this.release();
      throw error;
    }
  }

  resources(): { listenerCount: number; retainedBytes: number } {
    return {
      listenerCount: (this.room ? 2 : 0) + (this.client ? 1 : 0),
      retainedBytes:
        this.pinnedEventIds().length * 8 + this.pinnedMessages().length * 8,
    };
  }

  release(): void {
    this.room?.off(RoomStateEvent.Events, this.onStateEvent);
    this.room?.off(RoomEvent.Timeline, this.onTimeline);
    this.client?.off(MatrixEventEvent.Decrypted, this.onDecrypted);
    this.scheduleResolve.cancel();
    this.fetchToken = this.fetches.next();
    this.fetched = new Map();
    this.loading = new Set();
    this.queued = [];
    this.key = null;
    this.room = null;
    this.client = null;
    this.rawPinned = [];
    this.pinnedEventIds.set([]);
    this.pinnedMessages.set([]);
    this.mayMutate.set(false);
  }

  /** Re-fetch pins whose fetch failed; `missing` pins stay final. */
  retryFailed(): void {
    this.retryFailedPins(0);
  }

  /**
   * Re-fetch failed pins that failed at least `minAgeMs` ago. The failed entry stays
   * until the re-fetch resolves, so the row never flickers back to loading.
   */
  private retryFailedPins(minAgeMs: number): void {
    const now = Date.now();
    for (const [id, f] of this.fetched) {
      if (
        f.kind === 'failed' &&
        !this.loading.has(id) &&
        now - f.at >= minAgeMs
      ) {
        this.fetchPinned(id);
      }
    }
  }

  isPinned(eventId: string): boolean {
    return this.rawPinned.includes(eventId);
  }

  pin(eventId: string): Observable<ConversationPinOutcome> {
    return defer(() => {
      if (!this.key || !this.client || !this.room) {
        return of(this.rejected('pin', 'conversation-unavailable', false));
      }
      if (this.isPinned(eventId)) return of(this.applied('pin'));
      return this.write('pin', eventId, [...this.rawPinned, eventId]);
    });
  }

  unpin(eventId: string): Observable<ConversationPinOutcome> {
    return defer(() => {
      if (!this.key || !this.client || !this.room) {
        return of(this.rejected('unpin', 'conversation-unavailable', false));
      }
      if (!this.isPinned(eventId)) return of(this.applied('unpin'));
      return this.write(
        'unpin',
        eventId,
        this.rawPinned.filter((id) => id !== eventId),
      );
    });
  }

  private write(
    operation: ConversationPinOperation,
    eventId: string,
    pinned: readonly unknown[],
  ): Observable<ConversationPinOutcome> {
    const key = this.key;
    const client = this.client;
    const room = this.room;
    if (!key || !client || !room) {
      return of(this.rejected(operation, 'conversation-unavailable', false));
    }
    const decision = this.policy.authorize(key, operation, eventId);
    if (decision.kind === 'rejected') {
      return of(this.rejected(operation, decision.failure, false));
    }
    return from(
      client.sendStateEvent(
        room.roomId,
        EventType.RoomPinnedEvents,
        // Every entry of the room's list, non-strings included, is written back as read on
        // purpose; the cast only satisfies the SDK's `string[]` type.
        { pinned: [...pinned] as string[] },
        '',
      ),
    ).pipe(
      map(() => {
        this.readRoomState();
        return this.applied(operation);
      }),
      catchError((error: unknown) =>
        of(
          this.rejected(
            operation,
            'request-rejected',
            isTransientMatrixError(error),
          ),
        ),
      ),
    );
  }

  private readRoomState(): void {
    const key = this.key;
    const room = this.room;
    if (!key || !room) return;
    const state = liveRoomState(room);
    const raw = state
      ?.getStateEvents(EventType.RoomPinnedEvents, '')
      ?.getContent<{ pinned?: unknown }>().pinned;
    this.rawPinned = Array.isArray(raw) ? [...raw] : [];
    // Clients append, so the newest pins are the last ones.
    const pinned = this.rawPinned
      .filter((id): id is string => typeof id === 'string')
      .slice(-MAX_PINS);
    const current = this.pinnedEventIds();
    if (
      pinned.length !== current.length ||
      pinned.some((id, i) => id !== current[i])
    ) {
      this.fetchToken = this.fetches.next();
      this.fetched = new Map();
      this.loading = new Set();
      this.queued = [];
    } else {
      this.retryFailedPins(0);
    }
    this.pinnedEventIds.set(Object.freeze([...pinned]));
    this.mayMutate.set(this.policy.canMutate(key));
    this.resolvePinned();
  }

  private resolvePinned(): void {
    const room = this.room;
    if (!room) {
      this.pinnedMessages.set([]);
      return;
    }
    const views: PinnedMessageView[] = [];
    const unencryptedShield = unencryptedShieldFor(
      room,
      this.encryption.isEncrypted(room),
    );
    for (const id of this.pinnedEventIds()) {
      let event = room.findEventById(id);
      if (!event && !this.fetched.has(id)) {
        if (!this.loading.has(id)) this.fetchPinned(id);
        views.push(this.placeholder(id, 'loading'));
        continue;
      }
      if (!event) {
        const fetched = this.fetched.get(id);
        if (fetched?.kind !== 'loaded') {
          views.push(
            this.placeholder(
              id,
              fetched?.kind === 'failed' ? 'failed' : 'unavailable',
            ),
          );
          continue;
        }
        event = fetched.event;
      }
      if (event.isRedacted()) continue;
      const sender = event.getSender() ?? '';
      views.push(
        Object.freeze({
          id,
          status: 'loaded' as const,
          sender,
          senderName: room.getMember(sender)?.name ?? sender,
          // The pin's shield marks unencrypted text, so the text itself stays readable.
          body: messagePreview(event),
          ts: event.getTs(),
          shield: unencryptedShield(event),
        }),
      );
    }
    this.pinnedMessages.set(Object.freeze(views));
  }

  private placeholder(
    id: string,
    status: 'loading' | 'unavailable' | 'failed',
  ): PinnedMessageView {
    return Object.freeze({
      id,
      status,
      sender: '',
      senderName: '',
      body: '',
      ts: 0,
      shield: null,
    });
  }

  /** Fetch (and decrypt) a pin the loaded timeline lacks; one request per pin list. */
  private fetchPinned(id: string): void {
    const client = this.client;
    const roomId = this.key?.roomId;
    if (!client || !roomId) return;
    this.loading.add(id);
    if (this.activeFetches >= MAX_CONCURRENT_PIN_FETCHES) {
      this.queued.push(id);
      return;
    }
    this.runFetch(client, roomId, id);
  }

  private runFetch(client: MatrixClient, roomId: string, id: string): void {
    const token = this.fetchToken;
    this.activeFetches++;
    void (async () => {
      let result: PinFetch;
      try {
        const raw = await client.fetchRoomEvent(roomId, id);
        if (raw.room_id && raw.room_id !== roomId) {
          result = { kind: 'missing' };
        } else {
          const event = client.getEventMapper({ decrypt: false })({
            ...raw,
            room_id: roomId,
          });
          if (event.isEncrypted()) await client.decryptEventIfNeeded(event);
          result = { kind: 'loaded', event };
        }
      } catch (error) {
        // The server's "no" (not found / not allowed) is final; anything else is a failure
        // that the next invalidation retries.
        const status = (error as { httpStatus?: number } | null)?.httpStatus;
        result =
          status === 404 || status === 403
            ? { kind: 'missing' }
            : { kind: 'failed', at: Date.now() };
      }
      this.activeFetches--;
      const next = this.queued.shift();
      const { client: current, key } = this;
      if (next !== undefined && current && key) {
        this.runFetch(current, key.roomId, next);
      }
      if (!this.fetches.isCurrent(token)) return;
      this.loading.delete(id);
      this.fetched.set(id, result);
      this.scheduleResolve.schedule();
    })();
  }

  private applied(operation: ConversationPinOperation): ConversationPinOutcome {
    return { kind: 'applied', operation };
  }

  private rejected(
    operation: ConversationPinOperation,
    failure: Extract<ConversationPinOutcome, { kind: 'rejected' }>['failure'],
    retryable: boolean,
  ): ConversationPinOutcome {
    return { kind: 'rejected', operation, failure, retryable };
  }
}
