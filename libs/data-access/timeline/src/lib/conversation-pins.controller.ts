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
} from '@trinity/util/matrix';
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
  | { readonly kind: 'failed' };

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
  private readonly pinnedMessages = signal<readonly PinnedMessageView[]>([]);
  private readonly mayMutate = signal(false);
  /** Pins fetched because the loaded timeline lacks them. */
  private fetched = new Map<string, PinFetch>();
  private loading = new Set<string>();
  /** Invalidated when the pin list or room changes, so in-flight fetches drop their results. */
  private readonly fetches = latestGuard();
  private fetchToken = this.fetches.next();
  private key: ConversationKey | null = null;
  private room: Room | null = null;
  private client: MatrixClient | null = null;

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
  private readonly onTimeline = (): void => this.scheduleResolve.schedule();
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.key?.roomId) {
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
    room.on(RoomStateEvent.Events, this.onStateEvent);
    room.on(RoomEvent.Timeline, this.onTimeline);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    this.readRoomState();
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
    this.fetches.invalidate();
    this.fetchToken = this.fetches.next();
    this.fetched = new Map();
    this.loading = new Set();
    this.key = null;
    this.room = null;
    this.client = null;
    this.pinnedEventIds.set([]);
    this.pinnedMessages.set([]);
    this.mayMutate.set(false);
  }

  isPinned(eventId: string): boolean {
    return this.pinnedEventIds().includes(eventId);
  }

  pin(eventId: string): Observable<ConversationPinOutcome> {
    return defer(() => {
      if (!this.key || !this.client || !this.room) {
        return of(this.rejected('pin', 'conversation-unavailable', false));
      }
      if (this.isPinned(eventId)) return of(this.applied('pin'));
      return this.write('pin', eventId, [...this.pinnedEventIds(), eventId]);
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
        this.pinnedEventIds().filter((id) => id !== eventId),
      );
    });
  }

  private write(
    operation: ConversationPinOperation,
    eventId: string,
    pinned: readonly string[],
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
        { pinned: [...pinned] },
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
    const pinned =
      state
        ?.getStateEvents(EventType.RoomPinnedEvents, '')
        ?.getContent<{ pinned?: string[] }>().pinned ?? [];
    const current = this.pinnedEventIds();
    if (
      pinned.length !== current.length ||
      pinned.some((id, i) => id !== current[i])
    ) {
      this.fetches.invalidate();
      this.fetchToken = this.fetches.next();
      this.fetched = new Map();
      this.loading = new Set();
    } else {
      // Retry failed pins on the next invalidation.
      for (const [id, f] of this.fetched) {
        if (f.kind === 'failed') this.fetched.delete(id);
      }
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
          body: messagePreview(event),
          ts: event.getTs(),
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
    });
  }

  /** Fetch (and decrypt) a pin the loaded timeline lacks; one request per pin list. */
  private fetchPinned(id: string): void {
    const client = this.client;
    const roomId = this.key?.roomId;
    if (!client || !roomId) return;
    const token = this.fetchToken;
    this.loading.add(id);
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
            : { kind: 'failed' };
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
