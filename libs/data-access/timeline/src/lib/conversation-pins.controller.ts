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
      const event = room.findEventById(id);
      if (!event || event.isRedacted()) continue;
      const sender = event.getSender() ?? '';
      views.push(
        Object.freeze({
          id,
          sender,
          senderName: room.getMember(sender)?.name ?? sender,
          body: messagePreview(event),
          ts: event.getTs(),
        }),
      );
    }
    this.pinnedMessages.set(Object.freeze(views));
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
