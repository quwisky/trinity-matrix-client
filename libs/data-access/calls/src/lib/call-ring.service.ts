import { Injectable, OnDestroy, effect, inject, signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  EventTimeline,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { callParticipants } from './call-intent';
import {
  DECLINE_EVENT_TYPE,
  RING_EVENT_TYPES,
  ringExpiry,
  ringVideo,
  type IncomingRing,
} from './call-ring';
import type { RawCallEvent } from './call-transport';

const CALL_MEMBER_TYPE = 'org.matrix.msc3401.call.member';
const ENCRYPTED_TYPE = 'm.room.encrypted';

interface Binding {
  readonly client: MatrixClient;
  readonly pending: Set<string>;
  readonly onTimeline: (
    event: MatrixEvent,
    room: unknown,
    toStart: boolean | undefined,
    removed: boolean,
    data: { liveEvent?: boolean },
  ) => void;
  readonly onDecrypted: (event: MatrixEvent) => void;
  readonly onState: (event: MatrixEvent) => void;
}

function raw(event: MatrixEvent): RawCallEvent {
  return {
    type: event.getType(),
    event_id: event.getId() ?? '',
    room_id: event.getRoomId() ?? '',
    sender: event.getSender() ?? '',
    origin_server_ts: event.getTs(),
    content: event.getContent(),
  };
}

/** Rings for a call started in a direct chat, on any signed-in account, one prompt at a time. */
@Injectable({ providedIn: 'root' })
export class CallRingService implements OnDestroy {
  private readonly clients = inject(MatrixClientService);
  private readonly bindings = new Map<string, Binding>();
  private readonly ring = signal<IncomingRing | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly incomingRing = this.ring.asReadonly();

  constructor() {
    effect(() => {
      const ids = new Set(this.clients.accountIds());
      for (const id of [...this.bindings.keys()]) {
        const client = this.clients.clientFor(id);
        if (!ids.has(id) || client !== this.bindings.get(id)?.client) {
          this.unbind(id);
        }
      }
      for (const id of ids) {
        const client = this.clients.clientFor(id);
        if (client && !this.bindings.has(id)) this.bind(id, client);
      }
    });
  }

  ngOnDestroy(): void {
    for (const id of [...this.bindings.keys()]) this.unbind(id);
  }

  decline(): void {
    const ring = this.ring();
    if (!ring) return;
    this.clear();
    // SDK send methods are typed against its known event map.
    void this.clients
      .clientFor(ring.accountId)
      ?.sendEvent(
        ring.roomId,
        DECLINE_EVENT_TYPE as never,
        {
          'm.relates_to': { rel_type: 'm.reference', event_id: ring.id },
        } as never,
      )
      .catch(() => undefined);
  }

  dismiss(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.ring.set(null);
  }

  private bind(userId: string, client: MatrixClient): void {
    const pending = new Set<string>();
    const guard =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void => {
        // Runs inside the SDK's emit loop; a throw must never disrupt it.
        try {
          fn(...args);
        } catch {
          /* a ring failure is non-fatal */
        }
      };
    const binding: Binding = {
      client,
      pending,
      onTimeline: guard((event, _room, _toStart, _removed, data) => {
        if (data?.liveEvent !== true) return;
        if (event.getType() === ENCRYPTED_TYPE) {
          const id = event.getId();
          if (id) pending.add(id);
          return;
        }
        this.consider(userId, client, event);
      }),
      onDecrypted: guard((event) => {
        const id = event.getId();
        if (!id || !pending.has(id) || event.isDecryptionFailure()) return;
        pending.delete(id);
        this.consider(userId, client, event);
      }),
      onState: guard((event) => this.onMemberState(userId, event)),
    };
    this.bindings.set(userId, binding);
    client.on(RoomEvent.Timeline, binding.onTimeline as never);
    client.on(MatrixEventEvent.Decrypted, binding.onDecrypted);
    client.on(RoomStateEvent.Events, binding.onState);
  }

  private unbind(userId: string): void {
    const binding = this.bindings.get(userId);
    if (!binding) return;
    binding.client.off(RoomEvent.Timeline, binding.onTimeline as never);
    binding.client.off(MatrixEventEvent.Decrypted, binding.onDecrypted);
    binding.client.off(RoomStateEvent.Events, binding.onState);
    this.bindings.delete(userId);
    if (this.ring()?.accountId === userId) this.clear();
  }

  private consider(
    userId: string,
    client: MatrixClient,
    event: MatrixEvent,
  ): void {
    const type = event.getType();
    const sender = event.getSender() ?? '';
    const roomId = event.getRoomId() ?? '';
    const id = event.getId();
    if (!id || !roomId) return;
    if (type === DECLINE_EVENT_TYPE) {
      const target = (
        event.getContent()['m.relates_to'] as { event_id?: unknown } | undefined
      )?.event_id;
      const ring = this.ring();
      if (sender === userId && ring && ring.id === target) this.clear();
      return;
    }
    if (!RING_EVENT_TYPES.includes(type) || sender === userId) return;
    if (this.ring()?.id === id) return;
    const now = Date.now();
    const expiresAt = ringExpiry(
      {
        eventId: id,
        roomId,
        sender,
        type,
        content: event.getContent(),
        originServerTs: event.getTs(),
      },
      now,
    );
    if (expiresAt === null || !this.isDirect(client, roomId)) return;
    const room = client.getRoom(roomId);
    const members = (room
      ?.getLiveTimeline()
      .getState(EventTimeline.FORWARDS)
      ?.getStateEvents(CALL_MEMBER_TYPE) ?? []) as MatrixEvent[];
    const ownLive = members
      .filter((m) => m.getSender() === userId)
      .some((m) => callParticipants([raw(m)], now).count > 0);
    if (ownLive) return;
    this.clear();
    this.ring.set({
      id,
      roomId,
      accountId: userId,
      callerId: sender,
      callerName: room?.getMember(sender)?.name ?? sender,
      video: ringVideo(event.getContent()),
      expiresAt,
    });
    this.timer = setTimeout(() => {
      if (this.ring()?.id === id) this.clear();
    }, expiresAt - now);
  }

  private isDirect(client: MatrixClient, roomId: string): boolean {
    const direct = client
      .getAccountData(EventType.Direct)
      ?.getContent<Record<string, unknown>>();
    return Object.values(direct ?? {}).some(
      (rooms) => Array.isArray(rooms) && rooms.includes(roomId),
    );
  }

  private onMemberState(userId: string, event: MatrixEvent): void {
    const ring = this.ring();
    if (
      !ring ||
      ring.accountId !== userId ||
      event.getType() !== CALL_MEMBER_TYPE ||
      event.getRoomId() !== ring.roomId
    ) {
      return;
    }
    const live = callParticipants([raw(event)], Date.now()).count > 0;
    const sender = event.getSender();
    if ((sender === userId && live) || (sender === ring.callerId && !live)) {
      this.clear();
    }
  }
}
